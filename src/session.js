/**
 * A persistent, tool-enabled Claude Code session.
 *
 * Unlike the one-shot `ask()` in claude.js, this keeps a single `claude`
 * process alive for the whole interactive session and talks to it over the
 * bidirectional stream-json protocol. That buys three things the one-shot path
 * cannot give:
 *
 *   1. Native context across turns -- no --resume, no re-initialising.
 *   2. Real tool use (file edits, bash, ...), streamed as it happens.
 *   3. Interactive permission prompts, routed through the MCP permission server
 *      to the wrapper's UI (see permission.js / permserver.js).
 *
 * Because tools must be loaded for any of that to work, lean mode does not apply
 * here; the token win in interactive mode comes from prompt compression alone.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL } from './claude.js';

const PERM_SERVER = fileURLToPath(new URL('./permserver.js', import.meta.url));

const REPLY_STYLES = {
  terse: 'Be as brief as correctness allows. Lead with the answer; no preamble, no restating the request, no closing summary of what you did. Prefer short bullets over paragraphs. Summarise actions in 1-3 lines by default, expanding only if the user asks or something failed. Do not repeat file paths, commands, or diffs already shown in the terminal. Never abbreviate code, identifiers, paths, or commands, and never drop an error or required warning.',
  normal: 'Answer in complete prose, concise and answer-first. The compression applies to the input only. Still omit filler and do not restate paths, commands, or diffs already visible.',
};

export class Session {
  /**
   * @param {object} opts
   * @param {import('./permission.js').PermissionBroker} opts.broker
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.broker = opts.broker;
    this.bin = opts.bin ?? 'claude';
    this.child = null;
    this.buf = '';
    this.sessionId = null;
    this.turn = null; // { resolve, reject, callbacks, text }
    this.started = false;
    // Monotonic generation, bumped on every spawn/teardown. Child event handlers
    // capture the generation they were registered under and ignore events once a
    // newer process supersedes them -- so a killed process draining its buffers
    // can never corrupt the state of the one that replaced it.
    this.gen = 0;
    this.interruptSeq = 0;
  }

  start() {
    if (this.started) return;
    const { reply = 'terse', model, permissionMode = 'default' } = this.opts;

    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', permissionMode,
      '--append-system-prompt', `${PROTOCOL}\n${REPLY_STYLES[reply] ?? REPLY_STYLES.terse}`,
    ];
    if (this.broker) {
      args.push('--mcp-config', this.broker.mcpConfig(PERM_SERVER));
      args.push('--permission-prompt-tool', 'mcp__cwperm__approve');
    }
    if (model) args.push('--model', model);

    const child = spawn(this.bin, args, { cwd: this.opts.cwd ?? process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    const gen = (this.gen += 1);
    this.child = child;
    this.buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (gen === this.gen) this.onStdout(c); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {}); // swallow; errors surface via close
    child.on('close', (code) => { if (gen === this.gen) this.onClose(code); });
    child.on('error', (err) => { if (gen === this.gen) this.onSpawnError(err); });
    this.started = true;
  }

  /**
   * Update spawn-time configuration (model, reply style). These options are
   * baked into the child process's argv, so a live session must be torn down
   * for a change to take effect; the next send() starts a fresh process. Options
   * changed before the first send() just update the pending config, cheaply.
   *
   * @returns {boolean} true iff a *running* session was reset (its conversation
   *   context is now lost -- the caller should say so).
   */
  configure(patch = {}) {
    const SPAWN_KEYS = ['model', 'reply', 'permissionMode'];
    const changed = SPAWN_KEYS.some((k) => k in patch && patch[k] !== this.opts[k]);
    Object.assign(this.opts, patch);
    if (changed && this.started) {
      this.reset();
      return true;
    }
    return false;
  }

  /**
   * Drop the current process and all of its conversation context. The next
   * send() transparently starts a fresh session. Safe to call when idle or
   * mid-turn (an in-flight turn rejects with a "reset" error).
   */
  reset() {
    this.gen += 1; // orphan the old child's event handlers immediately
    const child = this.child;
    if (child) {
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
    }
    this.child = null;
    this.started = false;
    this.buf = '';
    this.sessionId = null;
    if (this.turn) {
      this.turn.reject(new Error('session reset'));
      this.turn = null;
    }
  }

  /**
   * Ask the running turn to stop. Sends the streaming-input interrupt control
   * request; the turn then ends with a normal result event, preserving session
   * context. No-op (returns false) when idle or when the write fails -- callers
   * should fall back to reset() to force a stop.
   *
   * @returns {boolean} true if the interrupt was written.
   */
  interrupt() {
    if (!this.started || !this.child || !this.turn) return false;
    const requestId = `int_${(this.interruptSeq += 1)}`;
    try {
      this.child.stdin.write(
        JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n',
      );
      return true;
    } catch {
      return false;
    }
  }

  onSpawnError(err) {
    const message = err?.code === 'ENOENT'
      ? `Could not find "${this.bin}" on PATH. Install Claude Code: npm i -g @anthropic-ai/claude-code`
      : err.message;
    if (this.turn) { this.turn.reject(new Error(message)); this.turn = null; }
  }

  onClose(code) {
    if (this.turn) {
      this.turn.reject(new Error(`claude exited (code ${code}) mid-turn.`));
      this.turn = null;
    }
    this.started = false;
  }

  /**
   * Send one user turn. Resolves when the turn's result arrives.
   * @param {string} text  The (compressed) prompt.
   * @param {object} cb    { onText, onToolUse, onToolResult }
   */
  send(text, cb = {}) {
    if (!this.started) this.start();
    return new Promise((resolve, reject) => {
      this.turn = { resolve, reject, cb, text: '', toolNames: new Map() };
      const msg = { type: 'user', message: { role: 'user', content: text } };
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  onStdout(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this.dispatch(ev);
    }
  }

  dispatch(ev) {
    if (ev.session_id) this.sessionId = ev.session_id;
    const turn = this.turn;

    switch (ev.type) {
      case 'stream_event': {
        const delta = ev.event?.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          turn?.cb.onText?.(delta.text);
          if (turn) turn.text += delta.text;
        }
        break;
      }
      case 'assistant': {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') {
            turn?.toolNames.set(block.id, block.name);
            turn?.cb.onToolUse?.({ id: block.id, name: block.name, input: block.input });
          }
        }
        break;
      }
      case 'user': {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_result') {
            const name = turn?.toolNames.get(block.tool_use_id);
            turn?.cb.onToolResult?.({
              id: block.tool_use_id,
              name,
              isError: block.is_error === true,
              content: flattenResult(block.content),
            });
          }
        }
        break;
      }
      case 'result': {
        if (turn) {
          turn.resolve({
            text: turn.text || (typeof ev.result === 'string' ? ev.result : ''),
            usage: ev.usage ?? null,
            cost: ev.total_cost_usd ?? null,
            sessionId: this.sessionId,
            isError: ev.is_error === true,
          });
          this.turn = null;
        }
        break;
      }
      default:
        break;
    }
  }

  stop() {
    this.gen += 1; // ignore any final drain from the dying child
    try { this.child?.stdin.end(); } catch {}
    try { this.child?.kill('SIGTERM'); } catch {}
    this.child = null;
    this.started = false;
  }
}

function flattenResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('');
  }
  return '';
}
