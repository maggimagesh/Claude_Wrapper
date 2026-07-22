#!/usr/bin/env node
/**
 * claudecode-wrapper -- a middleman between the terminal and Claude Code.
 *
 * Takes a raw prompt, rewrites it into compressed caveman notation, hands that
 * to the local `claude` CLI, and prints the reply. No credentials are requested
 * or stored; authentication is whatever the installed Claude Code already uses.
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { sync as spawnSync } from 'cross-spawn';
import { compress } from '../src/compress.js';
import { ask, inputTokens, pickLean } from '../src/claude.js';
import { loadConfig, saveConfig, CONFIG_PATH } from '../src/config.js';
import { estimateTokens } from '../src/tokens.js';
import { startTui } from '../src/tui.js';
import * as ui from '../src/render.js';
import { renderMarkdown } from '../src/output.js';

// Read the name and version from package.json so the CLI can never drift from
// the published package (npm version bumps package.json, not this file).
const PKG = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const VERSION = PKG.version;
const PKG_NAME = PKG.name;

const OPTIONS = {
  dry: { type: 'boolean', short: 'd' },
  show: { type: 'boolean', short: 's' },
  reply: { type: 'string' },
  raw: { type: 'boolean' },
  slots: { type: 'boolean' },
  'no-slots': { type: 'boolean' },
  stream: { type: 'boolean' },
  lean: { type: 'boolean' },
  'no-lean': { type: 'boolean' },
  stats: { type: 'boolean' },
  'no-stats': { type: 'boolean' },
  model: { type: 'string', short: 'm' },
  continue: { type: 'boolean', short: 'c' },
  resume: { type: 'string', short: 'r' },
  'permission-mode': { type: 'string' },
  'allow-tool': { type: 'string', multiple: true },
  'add-dir': { type: 'string', multiple: true },
  bin: { type: 'string' },
  config: { type: 'boolean' },
  uninstall: { type: 'boolean' },
  json: { type: 'boolean' },
  interactive: { type: 'boolean', short: 'i' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const HELP = `
${ui.bold('claudecode-wrapper')} -- compress prompts, then run them through Claude Code.

${ui.bold('USAGE')}
  cw                         open the interactive session (Claude-Code style)
  cw "<prompt>"              compress and send one prompt
  cw -d "<prompt>"           compress only, do not send
  echo "<prompt>" | cw       read the prompt from stdin

${ui.bold('COMPRESSION')}
  -d, --dry            show the compressed prompt and exit
  -s, --show           send, but print the compressed prompt first
      --raw            skip compression entirely, pass the prompt through
      --slots          always use the DO/RE/CTX/REQ/WANT form
      --no-slots       never use it; emit a single caveman line
      --reply <style>  terse (default) or normal -- how Claude writes back

${ui.bold('TOKENS')}
      --lean       drop tool definitions (~80% fewer input tokens, but
                   Claude cannot read files or run commands)
      --no-lean    always keep tools
                   default: auto -- lean only for explain/advise/plan
                   questions that name no file

${ui.bold('CLAUDE')}
  -m, --model <name>       opus, sonnet, haiku, or a full model id
  -c, --continue           continue the last session in this directory
  -r, --resume <id>        resume a specific session
      --stream             stream the reply as it is generated
      --permission-mode <m>  acceptEdits, plan, bypassPermissions, ...
      --allow-tool <t>     allow a tool (repeatable)
      --add-dir <path>     grant access to another directory (repeatable)
      --bin <path>         path to the claude binary (default: claude)

${ui.bold('OTHER')}
  -i, --interactive  force the interactive session
      --no-stats     hide the token savings line
      --config       write the current flags to ${CONFIG_PATH}
      --uninstall    remove the global install (npm rm -g ${PKG_NAME})
  -h, --help         this text
  -v, --version      version

Anything after ${ui.bold('--')} is passed straight to the claude CLI.

${ui.bold('EXAMPLES')}
  cw "hey, could you please take a look at src/auth.js? the login is
      throwing a null token error and I can't figure out why. thanks!"

  cw -d "refactor this, but don't touch the public API"
  cw --stream -m opus "add retry with backoff to the fetch helper"
`.trim();

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    ui.err(ui.red(error.message));
    ui.err('Run  cw --help  for usage.');
    process.exit(2);
  }

  const { values: flags, positionals } = parsed;

  if (flags.help) return ui.out(HELP);
  if (flags.version) return ui.out(`claudecode-wrapper ${VERSION}`);
  if (flags.uninstall) return uninstall();

  const config = loadConfig();

  const settings = {
    reply: flags.reply ?? config.reply,
    stream: flags.stream ?? config.stream,
    stats: flags['no-stats'] ? false : (flags.stats ?? config.stats),
    model: flags.model ?? config.model,
    bin: flags.bin ?? config.bin,
    permissionMode: flags['permission-mode'] ?? config.permissionMode,
    slots: flags.slots ? true : flags['no-slots'] ? false : config.slots,
    lean: flags.lean ? true : flags['no-lean'] ? false : (config.lean ?? 'auto'),
  };

  if (flags.config) {
    const path = saveConfig({
      reply: settings.reply,
      stream: settings.stream,
      stats: settings.stats,
      model: settings.model,
      bin: settings.bin,
      permissionMode: settings.permissionMode,
      slots: settings.slots,
      lean: settings.lean,
    });
    return ui.out(`Saved ${path}`);
  }

  if (settings.reply !== 'terse' && settings.reply !== 'normal') {
    ui.err(ui.red(`--reply must be "terse" or "normal", got "${settings.reply}".`));
    process.exit(2);
  }

  // Everything after `--` goes to the child process untouched.
  const separator = process.argv.indexOf('--');
  const passthrough = separator === -1 ? [] : process.argv.slice(separator + 1);
  const words = separator === -1 ? positionals : positionals.filter((p) => !passthrough.includes(p));

  const runOptions = {
    ...settings,
    continueSession: flags.continue,
    resume: flags.resume,
    allowedTools: flags['allow-tool'],
    addDir: flags['add-dir'] ?? [],
    passthrough,
  };

  let raw = words.join(' ').trim();
  if (!raw && !process.stdin.isTTY) raw = (await readStdin()).trim();

  // The interactive front-end is the default when there's nothing to do and a
  // real terminal is attached: bare `cw`, or an explicit `cw -i`.
  if (flags.interactive || (!raw && process.stdin.isTTY)) {
    return startTui({
      reply: settings.reply,
      model: settings.model,
      lean: settings.lean,
      stats: settings.stats,
      bin: settings.bin,
    });
  }

  if (!raw) {
    ui.err(ui.red('No prompt given.'));
    ui.err('Pass one as an argument, pipe it on stdin, or run  cw -i  for a session.');
    process.exit(2);
  }

  await run(raw, runOptions, flags);
}

/** Compress one prompt, send it, print the reply. */
async function run(raw, options, flags) {
  const result = flags.raw
    ? { prompt: raw, before: estimateTokens(raw), after: estimateTokens(raw), intent: { action: 'DO', constraints: [] } }
    : compress(raw, { slots: options.slots });

  if (flags.dry) {
    ui.showDryRun({ ...result, rawText: raw });
    return;
  }

  if (flags.show) ui.showPrompt(result);

  // Tool definitions dominate the token bill, so dropping them when the request
  // does not need the repo saves far more than the prompt rewrite does.
  const lean = flags.raw
    ? options.lean === true
    : pickLean(result.intent, result.subjects ?? [], options.lean);

  let streamed = false;
  const response = await ask(result.prompt, {
    ...options,
    lean,
    protocol: !flags.raw,
    onDelta: (options.stream && !flags.json)
      ? (text) => {
          streamed = true;
          process.stdout.write(text);
        }
      : undefined,
  });

  // Machine-readable output for scripting and benchmarking: one JSON object
  // with the answer alongside the real token/cost figures, nothing else.
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      answer: (response.text ?? '').trim(),
      estBefore: result.before,
      estAfter: result.after,
      inputTokens: inputTokens(response.usage),
      outputTokens: response.usage?.output_tokens ?? null,
      cost: response.cost ?? null,
      durationMs: response.durationMs ?? null,
      lean,
      compressed: !flags.raw,
      prompt: result.prompt,
    }) + '\n');
    return response;
  }

  if (streamed) {
    process.stdout.write('\n');
  } else if (response.text) {
    // Render the model's markdown to styled terminal text (plain when piped).
    ui.out(renderMarkdown(response.text));
  }

  if (options.stats) {
    ui.showStats({
      before: result.before,
      after: result.after,
      real: inputTokens(response.usage),
      cost: response.cost,
      durationMs: response.durationMs,
      lean,
    });
  }

  return response;
}

/**
 * Remove the global install. Works whether it was installed with `npm i -g`
 * or `npm link` -- `npm rm -g <name>` unlinks both. Delegates to the real npm
 * so it honours the user's global prefix, permissions, and package manager.
 */
function uninstall() {
  ui.out(`Removing the global install of ${PKG_NAME} ...`);
  // cross-spawn resolves `npm` to `npm.cmd` on Windows automatically.
  const result = spawnSync('npm', ['rm', '-g', PKG_NAME], { stdio: 'inherit' });
  if (result.error) {
    ui.err(ui.red(`Could not run npm: ${result.error.message}`));
    ui.err(`Uninstall manually with:  npm rm -g ${PKG_NAME}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    ui.err(ui.red(`npm exited with code ${result.status}.`));
    ui.err(`If it persists, try:  npm rm -g ${PKG_NAME}`);
    process.exit(result.status ?? 1);
  }
  ui.out(ui.green('Uninstalled. The `cw` and `claudecode-wrapper` commands are gone.'));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

main().catch((error) => {
  ui.err(ui.red(error.message ?? String(error)));
  process.exit(1);
});
