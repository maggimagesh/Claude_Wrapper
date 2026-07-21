#!/usr/bin/env node
/**
 * MCP permission server.
 *
 * The `claude` CLI spawns this as an MCP server and is told (via
 * --permission-prompt-tool) to route every tool-permission decision through its
 * one tool, `approve`. This process does not decide anything itself: it relays
 * each request over a Unix domain socket to the wrapper's main process, which
 * shows the prompt in the TUI and sends back the user's choice.
 *
 * Transport is newline-delimited JSON-RPC 2.0 on stdio (the MCP stdio
 * convention). The socket path arrives in CW_PERM_SOCK.
 *
 * If the socket is missing or unreachable, every request is denied -- failing
 * closed is the safe default for a permission gate.
 */

import net from 'node:net';

const SOCK = process.env.CW_PERM_SOCK;

// --- socket link to the wrapper ---------------------------------------------

let sock = null;
let sockReady = false;
let sockBuf = '';
const pending = new Map(); // id -> resolve
let nextId = 0;

function connect() {
  if (!SOCK) return;
  sock = net.createConnection(SOCK);
  sock.setEncoding('utf8');
  sock.on('connect', () => { sockReady = true; });
  sock.on('data', (chunk) => {
    sockBuf += chunk;
    const lines = sockBuf.split('\n');
    sockBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  sock.on('error', () => { sockReady = false; });
  sock.on('close', () => { sockReady = false; });
}

/** Ask the wrapper for a decision. Resolves to { behavior, updatedInput?, message? }. */
function askWrapper(toolName, input, toolUseId) {
  return new Promise((resolve) => {
    if (!sock || !sockReady) {
      return resolve({ behavior: 'deny', message: 'permission channel unavailable' });
    }
    const id = `p${nextId += 1}`;
    pending.set(id, (msg) => resolve(msg));
    sock.write(JSON.stringify({ id, tool_name: toolName, input, tool_use_id: toolUseId }) + '\n');
  });
}

// --- MCP stdio server --------------------------------------------------------

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  stdinBuf += d;
  const lines = stdinBuf.split('\n');
  stdinBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claudecode-wrapper-perm', version: '0.1.0' },
      });
      break;

    case 'notifications/initialized':
      break; // notification, no reply

    case 'tools/list':
      reply(id, {
        tools: [{
          name: 'approve',
          description: 'Permission gate for claudecode-wrapper. Routes the decision to the user.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_use_id: { type: 'string' },
            },
          },
        }],
      });
      break;

    case 'tools/call': {
      const args = params?.arguments ?? {};
      const decision = await askWrapper(args.tool_name, args.input ?? {}, args.tool_use_id);
      // The permission-prompt-tool contract: return a single text block whose
      // text is the JSON decision.
      const payload = decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: decision.updatedInput ?? args.input ?? {} }
        : { behavior: 'deny', message: decision.message ?? 'Denied by user.' };
      reply(id, { content: [{ type: 'text', text: JSON.stringify(payload) }] });
      break;
    }

    default:
      if (id !== undefined) reply(id, {});
  }
}

connect();
