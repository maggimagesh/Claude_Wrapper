/**
 * Wrapper-side permission broker.
 *
 * Opens a Unix domain socket that the MCP permission server (permserver.js,
 * spawned by the claude CLI) connects to. Each incoming request is handed to a
 * decision callback the TUI installs; the callback's result is sent back over
 * the socket and becomes the CLI's allow/deny.
 *
 * A policy layer sits in front of the callback so the experience matches Claude
 * Code: read-only tools are auto-approved, and "always allow" choices are
 * remembered for the rest of the session so the user isn't asked twice.
 */

import { createServer } from 'node:net';
import { unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tools that only observe the local workspace. Auto-approved so the session
 * isn't interrupted for harmless inspection.
 *
 * Deliberately excludes the network tools (WebFetch, WebSearch): those reach off
 * the machine and can carry local data out with them (fetch an attacker URL with
 * a just-read secret in the query), so they must be confirmed, not silent.
 */
const READ_ONLY = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead',
  'TodoWrite', 'TodoRead',
]);

export class PermissionBroker {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'cwperm-'));
    this.socketPath = join(this.dir, 'perm.sock');
    this.server = null;
    /** Per-session "always allow" grants, keyed by tool name. */
    this.always = new Set();
    /** Installed by the TUI: (req) => Promise<'once'|'always'|'deny'>. */
    this.onPrompt = null;
  }

  start() {
    this.server = createServer((conn) => {
      conn.setEncoding('utf8');
      let buf = '';
      conn.on('data', async (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let req;
          try { req = JSON.parse(line); } catch { continue; }
          const decision = await this.decide(req);
          conn.write(JSON.stringify({ id: req.id, ...decision }) + '\n');
        }
      });
      conn.on('error', () => {});
    });
    this.server.listen(this.socketPath);
    return this.socketPath;
  }

  async decide(req) {
    const tool = req.tool_name ?? 'unknown';

    // Auto-approve reads and already-"always"-granted tools.
    if (READ_ONLY.has(tool) || this.always.has(tool)) {
      return { behavior: 'allow', updatedInput: req.input ?? {} };
    }

    if (!this.onPrompt) {
      // No UI attached (shouldn't happen in the TUI): fail closed.
      return { behavior: 'deny', message: 'No permission handler.' };
    }

    const choice = await this.onPrompt(req);
    if (choice === 'always') {
      this.always.add(tool);
      return { behavior: 'allow', updatedInput: req.input ?? {} };
    }
    if (choice === 'once') {
      return { behavior: 'allow', updatedInput: req.input ?? {} };
    }
    return { behavior: 'deny', message: 'User declined this action.' };
  }

  /** MCP config JSON that points the CLI at permserver.js with our socket. */
  mcpConfig(permServerPath) {
    return JSON.stringify({
      mcpServers: {
        cwperm: {
          command: process.execPath,
          args: [permServerPath],
          env: { CW_PERM_SOCK: this.socketPath },
        },
      },
    });
  }

  stop() {
    try { this.server?.close(); } catch {}
    try { unlinkSync(this.socketPath); } catch {}
    try { rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }
}
