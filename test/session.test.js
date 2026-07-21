import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionBroker } from '../src/permission.js';
import { Session } from '../src/session.js';
import { summariseInput } from '../src/tui.js';

// --- session lifecycle -------------------------------------------------------
//
// These exercise the spawn-time config / reset / interrupt logic without
// launching a real `claude`: the child is stubbed and `started` is set by hand
// so the state transitions can be observed directly.

function stubChild() {
  const calls = { writes: [], killed: false, stdinEnded: false };
  return {
    calls,
    stdin: {
      write: (s) => { calls.writes.push(s); return true; },
      end: () => { calls.stdinEnded = true; },
    },
    kill: () => { calls.killed = true; },
  };
}

test('configure before start just updates pending options', () => {
  const session = new Session({ model: 'sonnet', reply: 'terse' });
  const wasReset = session.configure({ model: 'opus' });
  assert.equal(wasReset, false, 'no live process to reset');
  assert.equal(session.opts.model, 'opus');
});

test('configure with an unchanged value is a no-op', () => {
  const session = new Session({ model: 'opus' });
  session.started = true;
  session.child = stubChild();
  assert.equal(session.configure({ model: 'opus' }), false);
  assert.equal(session.started, true, 'unchanged config must not tear down the session');
});

test('configure on a live session tears it down so the change takes effect', () => {
  const session = new Session({ model: 'sonnet' });
  const child = stubChild();
  session.started = true;
  session.child = child;
  const wasReset = session.configure({ model: 'opus' });
  assert.equal(wasReset, true);
  assert.equal(session.started, false, 'the old process is stopped');
  assert.equal(child.calls.killed, true);
  assert.equal(session.opts.model, 'opus', 'the new model is stored for the next spawn');
});

test('reset clears session identity and rejects an in-flight turn', () => {
  const session = new Session();
  const child = stubChild();
  session.started = true;
  session.child = child;
  session.sessionId = 'abc';
  let rejected = null;
  session.turn = { resolve() {}, reject: (e) => { rejected = e; } };

  session.reset();

  assert.equal(session.started, false);
  assert.equal(session.sessionId, null);
  assert.equal(session.turn, null);
  assert.equal(child.calls.killed, true);
  assert.ok(rejected instanceof Error);
  assert.match(rejected.message, /reset/);
});

test('reset bumps the generation so a stale child cannot corrupt the next one', () => {
  const session = new Session();
  session.started = true;
  session.child = stubChild();
  const before = session.gen;
  session.reset();
  assert.ok(session.gen > before, 'generation advances to orphan old handlers');
});

test('interrupt is a no-op when idle', () => {
  const session = new Session();
  assert.equal(session.interrupt(), false, 'nothing to interrupt without a running turn');
});

test('interrupt writes a streaming-input interrupt control request', () => {
  const session = new Session();
  const child = stubChild();
  session.started = true;
  session.child = child;
  session.turn = { resolve() {}, reject() {} };

  assert.equal(session.interrupt(), true);
  assert.equal(child.calls.writes.length, 1);
  const msg = JSON.parse(child.calls.writes[0]);
  assert.equal(msg.type, 'control_request');
  assert.equal(msg.request.subtype, 'interrupt');
  assert.ok(msg.request_id, 'carries a request id');
});

// --- permission policy: the safety-critical part -----------------------------

test('local read-only tools are auto-approved without prompting', async () => {
  const broker = new PermissionBroker();
  broker.onPrompt = () => { throw new Error('should not prompt for reads'); };
  for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']) {
    const d = await broker.decide({ id: '1', tool_name: tool, input: { x: 1 } });
    assert.equal(d.behavior, 'allow', tool);
  }
});

test('network and delegation tools are NOT auto-approved (exfiltration gate)', async () => {
  for (const tool of ['WebFetch', 'WebSearch', 'Task']) {
    const broker = new PermissionBroker();
    let asked = false;
    broker.onPrompt = () => { asked = true; return 'deny'; };
    const d = await broker.decide({ id: '1', tool_name: tool, input: {} });
    assert.equal(asked, true, `${tool} must prompt, not auto-allow`);
    assert.equal(d.behavior, 'deny', tool);
  }
});

test('mutating tools prompt the user', async () => {
  const broker = new PermissionBroker();
  let asked = null;
  broker.onPrompt = (req) => { asked = req.tool_name; return 'once'; };
  const d = await broker.decide({ id: '1', tool_name: 'Bash', input: { command: 'ls' } });
  assert.equal(asked, 'Bash');
  assert.equal(d.behavior, 'allow');
});

test('"always" is remembered for the rest of the session', async () => {
  const broker = new PermissionBroker();
  let prompts = 0;
  broker.onPrompt = () => { prompts += 1; return 'always'; };

  const first = await broker.decide({ id: '1', tool_name: 'Write', input: {} });
  const second = await broker.decide({ id: '2', tool_name: 'Write', input: {} });

  assert.equal(first.behavior, 'allow');
  assert.equal(second.behavior, 'allow');
  assert.equal(prompts, 1, 'should only prompt once, then remember');
});

test('"deny" blocks the tool with a message', async () => {
  const broker = new PermissionBroker();
  broker.onPrompt = () => 'deny';
  const d = await broker.decide({ id: '1', tool_name: 'Bash', input: { command: 'rm -rf /' } });
  assert.equal(d.behavior, 'deny');
  assert.ok(d.message);
});

test('with no UI handler, unknown tools fail closed', async () => {
  const broker = new PermissionBroker();
  const d = await broker.decide({ id: '1', tool_name: 'Bash', input: {} });
  assert.equal(d.behavior, 'deny');
});

test('mcpConfig points the CLI at the perm server with the socket in env', () => {
  const broker = new PermissionBroker();
  const cfg = JSON.parse(broker.mcpConfig('/pkg/src/permserver.js'));
  const server = cfg.mcpServers.cwperm;
  assert.deepEqual(server.args, ['/pkg/src/permserver.js']);
  assert.equal(server.env.CW_PERM_SOCK, broker.socketPath);
  broker.stop();
});

// --- tool activity summaries -------------------------------------------------

test('tool inputs summarise to the salient argument', () => {
  assert.equal(summariseInput('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(summariseInput('Write', { file_path: 'src/a.js', content: 'x' }), 'src/a.js');
  assert.equal(summariseInput('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(summariseInput('WebFetch', { url: 'https://x.io' }), 'https://x.io');
});

test('long arguments are truncated', () => {
  const long = 'a'.repeat(200);
  const out = summariseInput('Bash', { command: long });
  assert.ok(out.length <= 81, out.length);
  assert.ok(out.endsWith('…'));
});

test('unknown tools fall back to their first argument', () => {
  assert.equal(summariseInput('Mystery', { foo: 'bar' }), 'bar');
  assert.equal(summariseInput('Empty', {}), '');
});
