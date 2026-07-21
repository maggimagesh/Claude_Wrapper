/**
 * The interactive front-end.
 *
 * A Claude-Code-style terminal session, built on the raw-mode primitives in
 * term.js and the buffer in editor.js -- no TUI dependency. It renders a
 * welcome banner and a redrawable, multi-line input box; on submit it compresses
 * the prompt, streams the reply from the local claude CLI, and prints a footer
 * showing what the wrapper saved.
 *
 * Layout is recomputed every keystroke from the current terminal width, so the
 * box reflows on resize and on multi-line paste.
 */

import { compress } from './compress.js';
import { inputTokens } from './claude.js';
import { Session } from './session.js';
import { PermissionBroker } from './permission.js';
import { estimateTokens, formatTokens, reduction } from './tokens.js';
import { LineEditor } from './editor.js';
import { decodeKeys, cursor, screen, bracketedPaste, visibleWidth } from './term.js';
import {
  dim, bold, red, green, yellow, cyan, accent,
} from './render.js';


/** Banner shown once at startup. */
export function renderBanner(state) {
  const width = boxWidth();
  const inner = width - 4;
  const line = (text = '') => `${dim('│')} ${pad(text, inner)} ${dim('│')}`;
  const rule = (l, r) => dim(l + '─'.repeat(width - 2) + r);

  const lines = [
    rule('╭', '╮'),
    line(`${accent('✻')} ${bold('claudecode-wrapper')}  ${dim('· A wrapper for Claude Code to reduce Token consumption')}`),
    line(),
    line(dim('Type naturally. Your prompt is compressed, sent to the local')),
    line(dim('claude CLI, and the reply comes back. No API key needed.')),
    line(),
    line(`${dim('model')} ${state.model ?? 'default'}   ${dim('reply')} ${state.reply}   ${dim('lean')} ${leanLabel(state.lean)}   ${dim('compress')} ${state.raw ? red('off') : green('on')}`),
    line(`${dim('/help for commands  ·  Ctrl+C to exit')}`),
    rule('╰', '╯'),
  ];
  return lines.join('\n');
}

/**
 * Interpret a slash command. Returns { handled, exit?, note?, redrawBanner? }.
 * Pure with respect to `state` mutation only, so it is unit-testable.
 */
export function handleSlash(input, state) {
  const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case 'help':
      return { handled: true, note: helpText() };
    case 'exit':
    case 'quit':
    case 'q':
      return { handled: true, exit: true };
    case 'clear':
    case 'cls':
      return { handled: true, clear: true };
    case 'new':
    case 'reset':
      state.sessionId = null;
      return { handled: true, resetSession: true, note: dim('started a fresh session') };
    case 'lean':
      state.lean = arg === 'auto' ? 'auto' : arg === 'off' ? false : true;
      return { handled: true, note: dim(`lean → ${leanLabel(state.lean)}`) };
    case 'nolean':
      state.lean = false;
      return { handled: true, note: dim('lean → off') };
    case 'raw':
      state.raw = !state.raw;
      return { handled: true, note: dim(`compression → ${state.raw ? 'off (raw passthrough)' : 'on'}`) };
    case 'reply':
      if (arg !== 'terse' && arg !== 'normal') {
        return { handled: true, note: red('usage: /reply terse|normal') };
      }
      state.reply = arg;
      return { handled: true, note: dim(`reply → ${arg}`) };
    case 'model':
      state.model = arg || null;
      return { handled: true, note: dim(`model → ${state.model ?? 'default'}`) };
    case 'show':
      state.show = !state.show;
      return { handled: true, note: dim(`show caveman prompt → ${state.show ? 'on' : 'off'}`) };
    case 'stats':
      state.stats = !state.stats;
      return { handled: true, note: dim(`stats → ${state.stats ? 'on' : 'off'}`) };
    default:
      return { handled: true, note: red(`unknown command: /${cmd}`) + dim('  (try /help)') };
  }
}

function helpText() {
  const row = (c, d) => `  ${cyan(c.padEnd(18))} ${dim(d)}`;
  return [
    bold('commands'),
    row('/help', 'this list'),
    row('/lean [auto|off]', 'drop tool defs to cut ~80% of input tokens'),
    row('/raw', 'toggle compression on/off'),
    row('/reply terse|normal', 'how Claude writes back'),
    row('/model <name>', 'opus, sonnet, haiku, or a full id'),
    row('/show', 'echo the compressed prompt each turn'),
    row('/stats', 'toggle the savings footer'),
    row('/new', 'forget the current session'),
    row('/clear', 'clear the screen'),
    row('/exit', 'quit'),
    '',
    bold('input'),
    row('Enter', 'send'),
    row('Alt+Enter  \\ then Enter', 'newline (multi-line prompt)'),
    row('↑ ↓', 'history (or move between lines)'),
    row('Ctrl+A / Ctrl+E', 'start / end of line'),
    row('Ctrl+U / Ctrl+K', 'delete to start / end of line'),
    row('Ctrl+W', 'delete previous word'),
    row('Ctrl+C', 'cancel a reply, or exit when the box is empty'),
  ].join('\n');
}

/**
 * Start the interactive session. Resolves when the user exits.
 */
export function startTui(baseOptions = {}) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    throw new Error('Interactive mode needs a TTY. Pass a prompt as an argument instead.');
  }

  const state = {
    reply: baseOptions.reply ?? 'terse',
    model: baseOptions.model ?? null,
    lean: baseOptions.lean ?? 'auto',
    raw: false,
    show: baseOptions.show ?? false,
    stats: baseOptions.stats ?? true,
    sessionId: null,
  };

  const editor = new LineEditor();
  const history = [];
  let historyIndex = -1; // -1 means "editing a new line"
  let draft = '';

  // Rows the input region printed last time, and the cursor's row within it,
  // so the next redraw can return to the top and clear down.
  let regionRows = 0;
  let cursorRowInRegion = 0;

  // Input routing. 'edit' = typing a prompt; 'busy' = a turn is streaming;
  // 'permission' = a permission selector is up and owns the keyboard.
  let mode = 'edit';
  let permissionKeyHandler = null;
  // Set once the user has pressed Ctrl+C/Esc during a turn; a second press then
  // force-stops instead of waiting for a graceful interrupt.
  let interruptArmed = false;

  // Tracks whether the last thing written to stdout ended a line, so tool lines
  // and prompts can guarantee they start fresh.
  let atLineStart = true;
  // Set while the "working" spinner is animating; any output clears it first so
  // text never collides with the spinner.
  let spinnerStop = null;
  function emit(text) {
    if (!text) return;
    if (spinnerStop) spinnerStop();
    stdout.write(text);
    atLineStart = text.endsWith('\n');
  }
  function freshLine() {
    if (!atLineStart) emit('\n');
  }

  // Permission broker + persistent tool-enabled Claude session.
  // broker.onPrompt is wired inside the Promise executor below, once
  // promptPermission is in scope.
  const broker = new PermissionBroker();
  broker.start();
  const session = new Session({ broker, reply: state.reply, model: state.model, bin: baseOptions.bin });

  stdout.write(`${renderBanner(state)}\n\n`);
  stdout.write(bracketedPaste.on);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve) => {
    const onData = (data) => {
      const keys = decodeKeys(data);
      if (mode === 'permission') {
        for (const key of keys) permissionKeyHandler?.(key);
        return;
      }
      if (mode === 'busy') {
        // Ctrl+C or Esc interrupts the running turn; a second press force-stops.
        for (const key of keys) {
          if ((key.type === 'ctrl' && key.key === 'c') || key.type === 'escape') {
            requestInterrupt();
          }
        }
        return;
      }
      for (const key of keys) handleKey(key);
    };

    const onResize = () => { if (mode === 'edit') renderInput(); };

    stdin.on('data', onData);
    stdout.on('resize', onResize);

    function finish() {
      // The cursor is parked inside the input box (on the "> " line). Drop it
      // below the whole region first, otherwise the returning shell prompt
      // prints on top of the box.
      if (regionRows > 0) {
        const down = (regionRows - 1) - cursorRowInRegion;
        if (down > 0) stdout.write(cursor.down(down));
        stdout.write('\r\n');
      }
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      stdout.write(bracketedPaste.off);
      stdout.write(cursor.show);
      stdin.setRawMode(false);
      stdin.pause();
      try { session.stop(); } catch {}
      try { broker.stop(); } catch {}
      stdout.write(dim('Exited...') + '\n');
      resolve();
    }

    async function handleKey(key) {
      switch (key.type) {
        case 'text':
          editor.insert(key.text);
          break;
        case 'paste':
          // Normalise pasted newlines; they become real lines in the buffer.
          editor.insert(key.text.replace(/\r\n?/g, '\n'));
          break;
        case 'enter':
          return submit();
        case 'alt-enter':
          editor.newline();
          break;
        case 'backspace':
          // "\" immediately before the caret is the newline chord's leftover;
          // a plain backspace still just deletes it.
          editor.backspace();
          break;
        case 'delete':
          editor.del();
          break;
        case 'left': editor.left(); break;
        case 'right': editor.right(); break;
        case 'home': editor.lineStart(); break;
        case 'end': editor.lineEnd(); break;
        case 'up':
          if (!editor.up()) recallHistory(-1);
          break;
        case 'down':
          if (!editor.down()) recallHistory(1);
          break;
        case 'escape':
          break;
        case 'ctrl':
          return handleCtrl(key.key);
        default:
          return;
      }
      renderInput();
    }

    function handleCtrl(k) {
      switch (k) {
        case 'c':
          if (editor.isEmpty) return finish();
          editor.clear();
          break;
        case 'd':
          if (editor.isEmpty) return finish();
          editor.del();
          break;
        case 'u': editor.killToLineStart(); break;
        case 'k': editor.killToLineEnd(); break;
        case 'w': editor.deleteWordBack(); break;
        case 'l':
          stdout.write(screen.clear);
          stdout.write(`${renderBanner(state)}\n\n`);
          regionRows = 0;
          break;
        default: return;
      }
      renderInput();
    }

    function recallHistory(direction) {
      if (!history.length) return;
      if (historyIndex === -1) {
        if (direction < 0) {
          draft = editor.value;
          historyIndex = history.length - 1;
        } else {
          return;
        }
      } else {
        historyIndex += direction;
      }

      if (historyIndex >= history.length) {
        historyIndex = -1;
        editor.setValue(draft);
      } else if (historyIndex < 0) {
        historyIndex = 0;
        editor.setValue(history[0]);
      } else {
        editor.setValue(history[historyIndex]);
      }
    }

    // Push settings that a slash command just changed into the live Claude
    // process. `/new` drops the session outright; `/model` and `/reply` are
    // spawn-time options, so changing them mid-conversation restarts the process
    // (and loses context) -- surface that as a note. Returns a note string, or ''.
    function applySessionConfig(before, result) {
      if (result.resetSession) {
        session.reset();
        return '';
      }
      const patch = {};
      if (state.model !== before.model) patch.model = state.model;
      if (state.reply !== before.reply) patch.reply = state.reply;
      if (!Object.keys(patch).length) return '';
      const wasReset = session.configure(patch);
      return wasReset ? dim('  (applied — the conversation context was reset)') : '';
    }

    async function submit() {
      let raw = editor.value.trim();
      if (!raw) return;

      // Bare "exit"/"quit" quit too, not just the slashed forms -- typing the
      // word alone is the reflex most people reach for.
      if (/^(exit|quit)$/i.test(raw)) {
        editor.clear();
        clearRegion();
        return finish();
      }

      if (raw.startsWith('/')) {
        editor.clear();
        historyIndex = -1;
        const before = { model: state.model, reply: state.reply };
        const result = handleSlash(raw, state);
        const resetNote = applySessionConfig(before, result);
        clearRegion();
        if (result.clear) {
          stdout.write(screen.clear);
          stdout.write(`${renderBanner(state)}\n\n`);
        }
        if (result.exit) return finish();
        if (result.note) emit(`${result.note}\n\n`);
        if (resetNote) emit(`${resetNote}\n\n`);
        return renderInput();
      }

      history.push(raw);
      historyIndex = -1;
      draft = '';
      editor.clear();

      clearRegion();
      echoUser(raw);

      await runTurn(raw);

      if (mode !== 'edit') mode = 'edit';
      renderInput();
    }

    function echoUser(raw) {
      const lines = raw.split('\n');
      emit(accent('❯ ') + lines[0] + '\n');
      for (const line of lines.slice(1)) emit('  ' + line + '\n');
      emit('\n');
      atLineStart = true;
    }

    async function runTurn(raw) {
      const result = state.raw
        ? { prompt: raw, before: estimateTokens(raw), after: estimateTokens(raw) }
        : compress(raw);

      if (state.show && !state.raw) {
        for (const line of result.prompt.split('\n')) emit(dim('│ ') + cyan(line) + '\n');
        emit('\n');
      }

      mode = 'busy';
      interruptArmed = false;
      startSpinner();
      let sawOutput = false;

      let response;
      try {
        response = await session.send(result.prompt, {
          onText: (text) => { sawOutput = true; emit(text); },
          onToolUse: (tool) => { sawOutput = true; renderToolUse(tool); },
          onToolResult: (res) => {
            sawOutput = true;
            renderToolResult(res);
            startSpinner(); // model resumes after the tool; show activity
          },
        });
      } catch (error) {
        stopSpinnerIfAny();
        freshLine();
        // A force-stop reset the session on purpose -- report it quietly, not as
        // an error.
        emit((error.message === 'session reset' ? dim('  (stopped)') : red(error.message)) + '\n\n');
        return;
      }

      freshLine();
      if (!sawOutput && response.text) emit(response.text.trim() + '\n');
      if (response.sessionId) state.sessionId = response.sessionId;

      if (state.stats) emit('\n' + statsLine(result, response) + '\n');
      emit('\n');
      atLineStart = true;
    }

    // --- interrupting a running turn -----------------------------------------

    // First Ctrl+C/Esc asks the model to stop gracefully (context preserved);
    // if the graceful interrupt can't be sent, or the user presses again, the
    // session is force-reset -- which rejects the in-flight send() and drops the
    // process. runTurn's catch handles the rejection and returns to edit mode.
    function requestInterrupt() {
      if (!interruptArmed) {
        interruptArmed = true;
        const sent = session.interrupt();
        if (sent) {
          stopSpinnerIfAny();
          freshLine();
          emit(dim('  (interrupting… press Ctrl+C again to force-stop)') + '\n');
          startSpinner();
        } else {
          forceStop();
        }
      } else {
        forceStop();
      }
    }

    function forceStop() {
      stopSpinnerIfAny();
      session.reset(); // rejects the pending send(); runTurn's catch takes over
    }

    // Claude-Code-style tool activity line: "● Write(hello.txt)".
    function renderToolUse(tool) {
      freshLine();
      emit(`${accent('●')} ${bold(tool.name)}${dim('(')}${dim(summariseInput(tool.name, tool.input))}${dim(')')}\n`);
    }

    function renderToolResult(res) {
      const body = (res.content ?? '').trim();
      const firstLine = body.split('\n')[0] ?? '';
      const mark = res.isError ? red('  ⎿ ') : dim('  ⎿ ');
      const text = firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine;
      emit(mark + (res.isError ? red(text) : dim(text)) + '\n');
    }

    // --- permission prompt ---------------------------------------------------

    function promptPermission(req) {
      return new Promise((resolve) => {
        stopSpinnerIfAny();
        freshLine();

        const options = [
          { key: 'y', label: 'Yes', value: 'once' },
          { key: 'a', label: `Yes, and don't ask again for ${req.tool_name}`, value: 'always' },
          { key: 'n', label: 'No, tell Claude what to do differently', value: 'deny' },
        ];
        let selected = 0;

        // The "● Tool(args)" header was already printed by renderToolUse when the
        // tool_use event arrived; don't repeat it here.
        emit(dim('  Allow this action?') + '\n');

        let optionRows = 0;
        const draw = () => {
          if (optionRows > 0) stdout.write(cursor.up(optionRows));
          for (let i = 0; i < options.length; i += 1) {
            const active = i === selected;
            const pointer = active ? accent('❯ ') : '  ';
            const text = active ? bold(options[i].label) : dim(options[i].label);
            stdout.write('\r' + screen.clearLine + `  ${pointer}${text}` + '\n');
          }
          optionRows = options.length;
          atLineStart = true;
        };
        draw();

        const done = (value) => {
          mode = 'busy';
          permissionKeyHandler = null;
          emit(dim(`  → ${value === 'deny' ? 'denied' : value === 'always' ? 'allowed (always)' : 'allowed'}`) + '\n\n');
          startSpinner(); // tool runs / model resumes after the decision
          resolve(value);
        };

        mode = 'permission';
        permissionKeyHandler = (key) => {
          if (key.type === 'up') { selected = (selected + options.length - 1) % options.length; draw(); }
          else if (key.type === 'down' || key.type === 'tab') { selected = (selected + 1) % options.length; draw(); }
          else if (key.type === 'enter') { done(options[selected].value); }
          else if (key.type === 'text') {
            const hit = options.find((o) => o.key === key.text.toLowerCase());
            if (hit) done(hit.value);
          } else if (key.type === 'ctrl' && key.key === 'c') { done('deny'); }
          else if (key.type === 'escape') { done('deny'); }
        };
      });
    }

    // --- spinner -------------------------------------------------------------
    // spinnerStop lives in the outer scope so emit() can clear it before any
    // write. startSpinner is a no-op if one is already running.

    function startSpinner() {
      if (spinnerStop) return;
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let i = 0;
      stdout.write(cursor.hide);
      const tick = () => {
        stdout.write(`\r${screen.clearLine}${accent(frames[i % frames.length])} ${accent('working')}`);
        i += 1;
      };
      tick();
      const timer = setInterval(tick, 80);
      spinnerStop = () => {
        clearInterval(timer);
        stdout.write(`\r${screen.clearLine}${cursor.show}`);
        atLineStart = true;
        spinnerStop = null;
      };
    }
    function stopSpinnerIfAny() {
      if (spinnerStop) spinnerStop();
    }

    // --- input box rendering -------------------------------------------------

    function clearRegion() {
      if (regionRows === 0) return;
      if (cursorRowInRegion > 0) stdout.write(cursor.up(cursorRowInRegion));
      stdout.write('\r' + screen.clearDown);
      regionRows = 0;
      cursorRowInRegion = 0;
    }

    function renderInput() {
      const width = boxWidth();
      const contentWidth = Math.max(8, width - 6); // "│ " + "> " + text + " │"
      const layout = layoutInput(editor.value, editor.cursor, contentWidth);

      clearRegion();

      const out = [];
      out.push(dim('╭' + '─'.repeat(width - 2) + '╮'));
      layout.rows.forEach((text, idx) => {
        const gutter = idx === 0 ? accent('> ') : '  ';
        const body = gutter + text;
        out.push(dim('│') + ' ' + pad(body, width - 4) + ' ' + dim('│'));
      });
      out.push(dim('╰' + '─'.repeat(width - 2) + '╯'));
      out.push(dim('  Enter send · Alt+Enter newline · /help'));

      // Print without a trailing newline on the last row, so the hardware
      // cursor ends in a known spot we can move back from.
      stdout.write(out.join('\n'));

      regionRows = out.length;
      const targetRow = 1 + layout.cursorRow; // + top border
      const targetCol = 1 + 2 + 2 + layout.cursorCol; // "│ " + "> " + col
      const upBy = (regionRows - 1) - targetRow;
      if (upBy > 0) stdout.write(cursor.up(upBy));
      stdout.write('\r');
      if (targetCol > 1) stdout.write(cursor.toColumn(targetCol));
      cursorRowInRegion = targetRow;
    }

    function statsLine(result, response) {
      const pct = reduction(result.before, result.after);
      const colour = pct >= 60 ? green : pct >= 30 ? yellow : dim;
      const real = inputTokens(response.usage);
      const parts = [
        dim('·'),
        `${dim('prompt')} ${result.before}→${result.after} ${colour(`-${pct}%`)}`,
      ];
      if (real != null) parts.push(dim(`| ${formatTokens(real)} in`));
      if (response.cost != null) parts.push(dim(`| $${response.cost.toFixed(4)}`));
      return parts.join(' ');
    }

    // Wire permission prompts and paint the first input box, now that every
    // helper is in scope.
    broker.onPrompt = (req) => promptPermission(req);
    renderInput();
  });
}

// --- pure helpers (exported for testing) ------------------------------------

/**
 * Wrap `value` to `contentWidth` and locate the cursor.
 * @returns {{ rows: string[], cursorRow: number, cursorCol: number }}
 */
export function layoutInput(value, cursorPos, contentWidth) {
  const logical = value.split('\n');
  const rows = [];
  let cursorRow = 0;
  let cursorCol = 0;
  let seen = 0; // characters consumed, including the '\n' separators

  logical.forEach((line, li) => {
    const chunks = wrap(line, contentWidth);
    const startRow = rows.length;
    rows.push(...chunks);

    const lineStart = seen;
    const lineEnd = seen + line.length;
    if (cursorPos >= lineStart && cursorPos <= lineEnd) {
      const offset = cursorPos - lineStart;
      const r = Math.floor(offset / contentWidth);
      cursorRow = startRow + r;
      cursorCol = offset - r * contentWidth;
    }
    seen = lineEnd + 1; // skip the '\n'
  });

  return { rows: rows.length ? rows : [''], cursorRow, cursorCol };
}

function wrap(line, width) {
  if (line.length === 0) return [''];
  const out = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out;
}

/** Compact one-line summary of a tool's input, à la Claude Code's activity log. */
export function summariseInput(toolName, input = {}) {
  const pick = (v) => {
    const s = String(v ?? '');
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  };
  switch (toolName) {
    case 'Bash': return pick(input.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return pick(input.file_path ?? input.path ?? input.notebook_path);
    case 'Glob': return pick(input.pattern);
    case 'Grep': return pick(input.pattern);
    case 'WebFetch': return pick(input.url);
    case 'WebSearch': return pick(input.query);
    case 'Task': return pick(input.description ?? input.subagent_type);
    default: {
      const first = Object.values(input)[0];
      return first === undefined ? '' : pick(typeof first === 'object' ? JSON.stringify(first) : first);
    }
  }
}

function boxWidth() {
  // Span the full terminal, like Claude Code's input. One column of margin on
  // the right keeps the border off the very edge on terminals that would
  // otherwise wrap it.
  const cols = process.stdout.columns || 80;
  return Math.max(24, cols - 1);
}

function leanLabel(lean) {
  return lean === true ? 'on' : lean === false ? 'off' : 'auto';
}

/** Pad (or truncate) to an exact visible width, ignoring ANSI codes. */
function pad(text, width) {
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w < width) return text + ' '.repeat(width - w);
  // Truncate on visible characters -- rare, only on a too-narrow terminal.
  return truncateVisible(text, width);
}

function truncateVisible(text, width) {
  let out = '';
  let count = 0;
  let i = 0;
  while (i < text.length && count < width) {
    if (text[i] === '\x1b') {
      const m = text.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += text[i];
    count += 1;
    i += 1;
  }
  return out;
}
