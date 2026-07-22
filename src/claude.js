/**
 * Bridge to the local Claude Code CLI.
 *
 * The wrapper never handles credentials. It shells out to whatever `claude`
 * binary is already on PATH and lets that process use the session the user
 * already authenticated -- OAuth, subscription, or an API key in their own
 * environment. Nothing is read, stored, or forwarded by this file.
 *
 * The prompt goes in over stdin rather than argv: prompts can exceed ARG_MAX,
 * and argv is world-readable in the process table.
 */

// cross-spawn launches the `claude` binary uniformly across platforms, including
// the Windows `claude.cmd` shim that the stdlib spawn cannot run directly.
import spawn from 'cross-spawn';
import { once } from 'node:events';

/**
 * The protocol brief. Prepended to Claude's system prompt so it can decode
 * caveman notation without the user's compressed prompt having to explain
 * itself every turn.
 *
 * Kept deliberately short -- it is sent on every call, so every token here is
 * a tax on the savings the compressor just earned.
 */
export const PROTOCOL = [
  'Input is compressed "caveman" notation from claudecode-wrapper: articles, copulas,',
  'and pleasantries are stripped; meaning is intact. Slots when present:',
  'DO=action, RE=files/symbols in scope, CTX=situation, REQ=hard constraints, WANT=deliverable.',
  'Expand it to full intent yourself. Terse input is not vagueness, and never a reason',
  'to ask the user to rephrase; ask only if genuinely ambiguous on the substance.',
  'REQ lines are binding. Treat NO/never/without as hard prohibitions.',
].join(' ');

/** Reply-style directives, selected by --reply. */
const REPLY_STYLES = {
  terse: [
    'Be as brief as correctness allows. Lead with the answer; no preamble, no',
    'restating the request, no pleasantries, no closing summary of what you did.',
    'Prefer short bullets over paragraphs; use prose only where it adds meaning.',
    'Summarise actions in 1-3 lines by default; expand only if the user asks or',
    'something failed. Do not repeat file paths, commands, code, or diffs already',
    'shown in the terminal. Never abbreviate code, identifiers, paths, or commands,',
    'and never drop an error, caveat, or required warning -- brevity trims fluff,',
    'not information.',
  ].join(' '),
  normal: [
    'Answer in complete English prose. Be concise and lead with the answer, but do',
    'not compress the reply -- the compression applies to the input only. Still omit',
    'filler and do not restate paths, commands, or diffs already visible.',
  ].join(' '),
};

/**
 * Build the argv for the child `claude` process.
 * @param {object} opts
 * @returns {string[]}
 */
export function buildArgs(opts = {}) {
  const {
    reply = 'terse',
    model,
    stream = false,
    continueSession = false,
    resume,
    permissionMode,
    allowedTools,
    addDir = [],
    passthrough = [],
    protocol = true,
  } = opts;

  const args = ['--print'];

  args.push('--output-format', stream ? 'stream-json' : 'json');
  if (stream) args.push('--include-partial-messages', '--verbose');

  // Lean mode: drop the built-in tool definitions.
  //
  // This is by far the largest lever the wrapper has. Measured on this machine,
  // a trivial prompt costs ~15.4k input tokens by default and ~2.6k with tools
  // disabled -- the tool schemas, not the user's words, are the bulk of a turn.
  // Only safe when the request needs no file or shell access; see pickLean().
  if (opts.lean) args.push('--tools', '');

  if (protocol) {
    const style = REPLY_STYLES[reply] ?? REPLY_STYLES.terse;
    args.push('--append-system-prompt', `${PROTOCOL}\n${style}`);
  }

  if (model) args.push('--model', model);
  if (continueSession) args.push('--continue');
  if (resume) args.push('--resume', resume);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (allowedTools?.length) args.push('--allowed-tools', ...allowedTools);
  for (const dir of addDir) args.push('--add-dir', dir);

  args.push(...passthrough);
  return args;
}

/**
 * Run a compressed prompt through the local claude CLI.
 *
 * @param {string} prompt Compressed prompt to send.
 * @param {object} opts
 * @param {(text: string) => void} [opts.onDelta] Called with streamed text.
 * @returns {Promise<{ text: string, usage: object|null, cost: number|null,
 *                     sessionId: string|null, durationMs: number, code: number }>}
 */
export async function ask(prompt, opts = {}) {
  const { bin = 'claude', cwd = process.cwd(), signal, onDelta } = opts;
  const args = buildArgs(opts);
  const started = Date.now();

  const child = spawn(bin, args, {
    cwd,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  child.stdin.end(prompt);

  let stdout = '';
  let stderr = '';
  let pending = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!opts.stream) return;

    // stream-json emits one JSON object per line.
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseLine(line);
      const delta = textDelta(event);
      if (delta && onDelta) onDelta(delta);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let code;
  try {
    [code] = await once(child, 'close');
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw wrapSpawnError(error, bin);
  }

  if (code !== 0) {
    const detail = (stderr || stdout).trim().split('\n').slice(0, 6).join('\n');
    throw new Error(
      `claude exited with code ${code}${detail ? `:\n${detail}` : '.'}`,
    );
  }

  const result = opts.stream ? parseStream(stdout) : parseJson(stdout);

  return {
    ...result,
    durationMs: Date.now() - started,
    code,
  };
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Pull incremental assistant text out of a stream-json event. */
function textDelta(event) {
  if (!event) return '';
  if (event.type === 'stream_event') {
    const delta = event.event?.delta;
    if (delta?.type === 'text_delta') return delta.text ?? '';
    return '';
  }
  return '';
}

function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '', usage: null, cost: null, sessionId: null };

  try {
    const parsed = JSON.parse(trimmed);
    return {
      text: typeof parsed.result === 'string' ? parsed.result : trimmed,
      usage: parsed.usage ?? null,
      cost: parsed.total_cost_usd ?? null,
      sessionId: parsed.session_id ?? null,
      isError: parsed.is_error ?? false,
    };
  } catch {
    // The CLI printed something that is not JSON -- surface it rather than lose it.
    return { text: trimmed, usage: null, cost: null, sessionId: null };
  }
}

function parseStream(stdout) {
  let text = '';
  let usage = null;
  let cost = null;
  let sessionId = null;

  for (const line of stdout.split('\n')) {
    const event = parseLine(line);
    if (!event) continue;

    if (event.type === 'result') {
      if (typeof event.result === 'string') text = event.result;
      usage = event.usage ?? usage;
      cost = event.total_cost_usd ?? cost;
      sessionId = event.session_id ?? sessionId;
    } else if (event.type === 'assistant' && !text) {
      const blocks = event.message?.content ?? [];
      text += blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    if (event.session_id) sessionId = event.session_id;
  }

  return { text, usage, cost, sessionId };
}

function wrapSpawnError(error, bin) {
  if (error?.code === 'ENOENT') {
    return new Error(
      `Could not find the "${bin}" command on PATH.\n` +
      'claudecode-wrapper drives your existing Claude Code install rather than talking to the API directly.\n' +
      'Install it with:  npm install -g @anthropic-ai/claude-code',
    );
  }
  return error;
}

/**
 * Decide whether a request can run without tools.
 *
 * Conservative by design: a false positive here means Claude is asked to
 * inspect a file it has no way to open, which is a broken answer rather than a
 * cheap one. Anything that names a file, or whose verb implies touching the
 * repo, keeps its tools.
 *
 * @param {object} intent   Result of classify().
 * @param {string[]} subjects Protected spans lifted from the prompt.
 * @param {boolean|'auto'} setting
 */
export function pickLean(intent, subjects, setting = 'auto') {
  if (setting !== 'auto') return Boolean(setting);

  // Verbs that answer from knowledge rather than from the codebase.
  const KNOWLEDGE_ONLY = new Set(['EXPLAIN', 'ADVISE', 'PLAN']);
  if (!KNOWLEDGE_ONLY.has(intent.action)) return false;

  // A named file, path, or flag means the answer depends on the repo.
  const referencesRepo = subjects.some((s) => /[/\\]|\.\w{1,5}$|^--/.test(s));
  return !referencesRepo;
}

/** Total input tokens across fresh and cached reads. */
export function inputTokens(usage) {
  if (!usage) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}
