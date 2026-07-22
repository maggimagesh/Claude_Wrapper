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
import { renderMarkdown } from './output.js';
import { createVim, handleVimKey } from './vim.js';
import { completePath, pathTokenAt } from './complete.js';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';


/** Banner shown once at startup. */
export function renderBanner(state) {
  const width = boxWidth();
  const inner = width - 4;
  const line = (text = '') => `${dim('│')} ${pad(text, inner)} ${dim('│')}`;
  const rule = (l, r) => dim(l + '─'.repeat(width - 2) + r);

  const lines = [
    rule('╭', '╮'),
    line(`${accent('✻')}  ${bold('claudecode-wrapper')}   ${dim('· token-saving front-end for Claude Code')}`),
    line(),
    line(dim('Type naturally — your prompt is compressed, sent to the')),
    line(dim('local claude CLI, and the reply streams back. No API key needed.')),
    rule('├', '┤'),
    line(`${badge('model', state.model ?? 'default')}   ${badge('reply', state.reply)}   ${badge('lean', leanLabel(state.lean))}   ${badge('compress', state.raw ? red('off') : green('on'))}`),
    line(dim('/help for commands   ·   / to browse them   ·   Ctrl+C to exit')),
    rule('╰', '╯'),
  ];
  return lines.join('\n');
}

/** A "label value" chip used in the banner and status line. */
function badge(label, value) {
  return `${dim(label)} ${value}`;
}

/**
 * The full slash-command catalogue. Drives both the interactive autocomplete
 * menu and /help, so the two never drift. `arg` is a usage hint shown in the
 * menu; it is purely cosmetic.
 */
export const SLASH_COMMANDS = [
  { name: 'help', hint: 'show commands and shortcuts' },
  { name: 'model', arg: '<name>', hint: 'opus, sonnet, haiku, or a full id' },
  { name: 'reply', arg: 'terse|normal', hint: 'how Claude writes back' },
  { name: 'lean', arg: '[auto|off]', hint: 'drop tool defs to cut input tokens' },
  { name: 'raw', hint: 'toggle prompt compression on/off' },
  { name: 'vim', hint: 'toggle vim keybindings' },
  { name: 'show', hint: 'echo the compressed prompt each turn' },
  { name: 'stats', hint: 'toggle the savings footer' },
  { name: 'new', hint: 'start a fresh session' },
  { name: 'clear', hint: 'clear the screen' },
  { name: 'exit', hint: 'quit the session' },
];

/**
 * Commands whose typed prefix matches `input`. Empty once the user starts
 * typing an argument (a space after the command), so the menu gets out of the
 * way. Pure, for testing.
 */
export function filterSlashCommands(input) {
  if (!input.startsWith('/')) return [];
  const rest = input.slice(1);
  if (/\s/.test(rest)) return []; // typing an argument -- hide the menu
  const q = rest.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
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
    case 'vim':
      state.vim = !state.vim;
      return { handled: true, vim: true, note: dim(`vim keybindings → ${state.vim ? 'on (NORMAL mode)' : 'off'}`) };
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
    row('Alt+Enter  or  \\ +Enter', 'newline (multi-line prompt)'),
    row('↑ ↓', 'history (or move between lines)'),
    row('Ctrl+R', 'reverse-search history'),
    row('Tab', 'complete a file path'),
    row('@path', 'file mention with completion menu'),
    row('!cmd', 'run a shell command locally'),
    row('#note', 'append a note to .cw-memory.md'),
    row('Shift+Tab', 'cycle permission mode (default/acceptEdits/plan)'),
    row('/vim', 'toggle vim keybindings'),
    row('type while busy', 'queued, replayed when the turn ends'),
    row('Ctrl+← / Ctrl+→', 'move by word'),
    row('Ctrl+A / Ctrl+E', 'start / end of line'),
    row('Ctrl+Home / Ctrl+End', 'start / end of the whole prompt'),
    row('Ctrl+U / Ctrl+K', 'delete to start / end of line'),
    row('Ctrl+W / Ctrl+Backspace', 'delete previous word'),
    row('Ctrl+Del', 'delete next word'),
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
    permissionMode: baseOptions.permissionMode ?? 'default',
    vim: false,
  };
  const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'];

  const editor = new LineEditor();
  const history = [];
  let historyIndex = -1; // -1 means "editing a new line"
  let draft = '';

  // Slash-command autocomplete. `menuItems` is recomputed on every render from
  // the current buffer; `menuIndex` is the highlighted row; `menuDismissed`
  // lets Esc hide the menu until the buffer changes again.
  let menuItems = [];
  let menuIndex = 0;
  let menuDismissed = false;
  let menuKind = null; // 'slash' | 'file'

  // Vim modal editing (toggled by /vim); reverse-search (Ctrl+R); and text
  // typed while a turn is streaming, replayed into the box when it finishes.
  const vim = createVim();
  let searchMode = null; // { query, matches, idx, saved } while Ctrl+R is active
  let pendingInput = '';
  let pendingSubmit = false;

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
        // Anything else the user types is queued and replayed into the input box
        // when the turn finishes, so composing the next message never blocks.
        for (const key of keys) {
          if ((key.type === 'ctrl' && key.key === 'c') || key.type === 'escape') {
            requestInterrupt();
          } else if (key.type === 'text') {
            pendingInput += key.text;
          } else if (key.type === 'paste') {
            pendingInput += key.text.replace(/\r\n?/g, '\n');
          } else if (key.type === 'backspace') {
            pendingInput = pendingInput.slice(0, -1);
          } else if (key.type === 'enter') {
            pendingSubmit = true; // auto-send the queued message once free
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

    // When the autocomplete menu is showing it captures navigation keys:
    // ↑/↓ move the highlight, Tab accepts, Esc hides it. Returns true when the
    // key was consumed so the normal editor handling is skipped.
    function handleMenuKey(key) {
      if (!menuItems.length) return false;
      switch (key.type) {
        case 'up':
          menuIndex = (menuIndex - 1 + menuItems.length) % menuItems.length;
          renderInput();
          return true;
        case 'down':
          menuIndex = (menuIndex + 1) % menuItems.length;
          renderInput();
          return true;
        case 'tab':
          acceptMenu();
          return true;
        case 'escape':
          menuDismissed = true;
          renderInput();
          return true;
        default:
          return false;
      }
    }

    /**
     * What the autocomplete menu should show for the current buffer: slash
     * commands when the line is a bare "/word", or file paths when the token at
     * the caret is an "@mention". Empty otherwise (or when dismissed).
     */
    function computeMenu() {
      if (menuDismissed) return { kind: null, items: [] };
      const v = editor.value;
      if (v.startsWith('/') && !/\s/.test(v.slice(1))) {
        return { kind: 'slash', items: filterSlashCommands(v) };
      }
      const { token } = pathTokenAt(v, editor.cursor);
      if (token.startsWith('@') && token.length >= 1) {
        const { matches } = completePath(token.slice(1), process.cwd());
        return { kind: 'file', items: matches.slice(0, 8).map((m) => ({ name: m })) };
      }
      return { kind: null, items: [] };
    }

    /** Accept the highlighted menu item into the buffer. */
    function acceptMenu() {
      const item = menuItems[menuIndex];
      if (!item) return;
      if (menuKind === 'slash') {
        editor.setValue(`/${item.name} `);
      } else if (menuKind === 'file') {
        const { start } = pathTokenAt(editor.value, editor.cursor);
        const before = editor.value.slice(0, start);
        const after = editor.value.slice(editor.cursor);
        const inserted = `@${item.name}`;
        editor.setValue(before + inserted + after, (before + inserted).length);
      }
      menuDismissed = false;
      renderInput();
    }

    /** Tab with no menu open: complete the path token at the caret in place. */
    function completePathAtCursor() {
      const { token, start } = pathTokenAt(editor.value, editor.cursor);
      if (!token) return;
      const { matches, common } = completePath(token, process.cwd());
      if (!matches.length) return;
      const replacement = matches.length === 1 ? matches[0] : common;
      if (replacement === token) return;
      const before = editor.value.slice(0, start);
      const after = editor.value.slice(editor.cursor);
      editor.setValue(before + replacement + after, (before + replacement).length);
      renderInput();
    }

    async function handleKey(key) {
      // Ctrl+R reverse-history-search owns the keyboard while it is open.
      if (searchMode) return handleSearchKey(key);

      // Vim normal mode intercepts everything; insert mode only intercepts Esc
      // and otherwise falls through to the normal editing below.
      if (state.vim) {
        if (vim.mode === 'normal') {
          const r = handleVimKey(key, editor, vim);
          if (r.submit) return submit();
          if (r.render) renderInput();
          return;
        }
        if (key.type === 'escape') { handleVimKey(key, editor, vim); return renderInput(); }
      }

      // Enter while the autocomplete menu is open accepts the highlighted item
      // instead of submitting the raw buffer. A slash command that takes no
      // argument is accepted and run in one Enter; one that expects an argument
      // is filled in so the user can type it. File mentions just get inserted.
      if (key.type === 'enter' && !menuDismissed && menuItems.length) {
        const item = menuItems[menuIndex];
        if (item) {
          if (menuKind === 'slash') {
            if (item.arg) {
              editor.setValue(`/${item.name} `);
              menuDismissed = false;
              renderInput();
              return;
            }
            editor.setValue(`/${item.name}`);
            menuItems = [];
            return submit();
          }
          acceptMenu();
          return;
        }
      }

      if (handleMenuKey(key)) return;
      // Any edit to the buffer un-dismisses the menu so it can reappear.
      if (key.type === 'text' || key.type === 'paste' || key.type === 'backspace') {
        menuDismissed = false;
      }
      switch (key.type) {
        case 'text':
          editor.insert(key.text);
          break;
        case 'paste':
          // Normalise pasted newlines; they become real lines in the buffer.
          editor.insert(key.text.replace(/\r\n?/g, '\n'));
          break;
        case 'enter':
          // Backslash-continuation: a trailing "\" turns Enter into a newline,
          // matching Claude Code's multi-line chord.
          if (editor.value.slice(0, editor.cursor).endsWith('\\')) {
            editor.backspace();
            editor.newline();
            break;
          }
          return submit();
        case 'tab':
          completePathAtCursor();
          return;
        case 'shift-tab':
          cyclePermissionMode();
          break;
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
        case 'delete-word':
          editor.deleteWordForward();
          break;
        case 'delete-word-back':
          editor.deleteWordBack();
          break;
        case 'left': editor.left(); break;
        case 'right': editor.right(); break;
        case 'word-left': editor.wordLeft(); break;
        case 'word-right': editor.wordRight(); break;
        case 'home': editor.lineStart(); break;
        case 'end': editor.lineEnd(); break;
        case 'doc-start': editor.docStart(); break;
        case 'doc-end': editor.docEnd(); break;
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
        case 'r': return startReverseSearch();
        case 'l':
          stdout.write(screen.clear);
          stdout.write(`${renderBanner(state)}\n\n`);
          regionRows = 0;
          break;
        default: return;
      }
      renderInput();
    }

    // --- Ctrl+R reverse-history-search ---------------------------------------

    function startReverseSearch() {
      if (!history.length) return;
      searchMode = { query: '', matches: [], idx: 0, saved: editor.value };
      renderInput();
    }

    function refreshSearch() {
      const q = searchMode.query.toLowerCase();
      // Most-recent-first, matching the readline convention.
      searchMode.matches = q
        ? [...history].reverse().filter((h) => h.toLowerCase().includes(q))
        : [];
      if (searchMode.idx >= searchMode.matches.length) searchMode.idx = 0;
      const hit = searchMode.matches[searchMode.idx];
      editor.setValue(hit ?? searchMode.query);
    }

    function handleSearchKey(key) {
      if (key.type === 'text') { searchMode.query += key.text; searchMode.idx = 0; refreshSearch(); return renderInput(); }
      if (key.type === 'backspace') { searchMode.query = searchMode.query.slice(0, -1); searchMode.idx = 0; refreshSearch(); return renderInput(); }
      if (key.type === 'ctrl' && key.key === 'r') { // cycle to an older match
        if (searchMode.matches.length) { searchMode.idx = (searchMode.idx + 1) % searchMode.matches.length; refreshSearch(); }
        return renderInput();
      }
      if (key.type === 'enter') { searchMode = null; return renderInput(); } // keep the match, ready to send/edit
      if (key.type === 'escape' || (key.type === 'ctrl' && key.key === 'c')) {
        editor.setValue(searchMode.saved);
        searchMode = null;
        return renderInput();
      }
      return; // ignore other keys while searching
    }

    // --- Shift+Tab permission-mode cycle -------------------------------------

    function cyclePermissionMode() {
      const i = PERMISSION_MODES.indexOf(state.permissionMode);
      state.permissionMode = PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length];
      // Spawn-time option: applies to the next turn (resets a live session).
      session.configure({ permissionMode: state.permissionMode });
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

      // "!cmd" runs a shell command locally; "#note" appends to the memory file.
      // Neither is sent to Claude -- they mirror Claude Code's bang/hash chords.
      if (raw.startsWith('!')) {
        editor.clear(); historyIndex = -1;
        history.push(raw); clearRegion();
        return runBash(raw.slice(1).trim());
      }
      if (raw.startsWith('#')) {
        editor.clear(); historyIndex = -1; clearRegion();
        return addMemory(raw.slice(1).trim());
      }

      if (raw.startsWith('/')) {
        editor.clear();
        historyIndex = -1;
        const before = { model: state.model, reply: state.reply };
        const result = handleSlash(raw, state);
        if (result.vim) vim.mode = 'normal'; // always land in NORMAL when toggled
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

      // Replay anything typed while the turn was streaming, and auto-send it if
      // the user pressed Enter during the wait.
      if (pendingInput) { editor.setValue(pendingInput); pendingInput = ''; }
      renderInput();
      if (pendingSubmit) { pendingSubmit = false; if (editor.value.trim()) return submit(); }
    }

    // --- "!" shell mode and "#" memory ---------------------------------------

    async function runBash(cmd) {
      if (!cmd) return renderInput();
      emit(accent('! ') + cmd + '\n');
      await new Promise((res) => {
        let child;
        try {
          // shell:true runs the line through the platform's own shell -- /bin/sh
          // on Linux/macOS, cmd.exe on Windows -- so "!cmd" works everywhere.
          child = spawn(cmd, { cwd: process.cwd(), shell: true });
        } catch (e) { emit(red(String(e.message)) + '\n'); return res(); }
        child.stdout.on('data', (d) => emit(d.toString()));
        child.stderr.on('data', (d) => emit(red(d.toString())));
        child.on('close', (code) => { freshLine(); emit(dim(`(exit ${code})`) + '\n\n'); res(); });
        child.on('error', (e) => { emit(red(String(e.message)) + '\n\n'); res(); });
      });
      atLineStart = true;
      renderInput();
    }

    function addMemory(note) {
      if (!note) return renderInput();
      const path = join(process.cwd(), '.cw-memory.md');
      try {
        appendFileSync(path, `- ${note}\n`);
        emit(green('# ') + dim(`saved to .cw-memory.md`) + '\n\n');
      } catch (e) {
        emit(red(`could not write memory: ${e.message}`) + '\n\n');
      }
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
      let textBuf = '';

      // Claude's answer arrives as a stream of markdown deltas. Markdown can't
      // be rendered token-by-token (fences, lists, tables only make sense whole),
      // so each text block is buffered and rendered when it ends -- when a tool
      // use interrupts it, or when the turn finishes. The spinner keeps spinning
      // meanwhile; the fully-styled block then replaces it.
      const flushText = () => {
        if (!textBuf.trim()) { textBuf = ''; return; }
        stopSpinnerIfAny();
        freshLine();
        emit(renderMarkdown(textBuf) + '\n');
        textBuf = '';
      };

      let response;
      try {
        response = await session.send(result.prompt, {
          onText: (text) => { sawOutput = true; textBuf += text; },
          onToolUse: (tool) => { sawOutput = true; flushText(); renderToolUse(tool); },
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

      flushText();
      freshLine();
      // Fallback for the non-streaming path: the result carried text but no
      // deltas arrived, so render it here.
      if (!sawOutput && response.text) emit(renderMarkdown(response.text) + '\n');
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
      const mark = res.isError ? red('  ⎿ ') : dim('  ⎿ ');
      // Errors are worth reading verbatim (truncated); successes collapse to a
      // short action summary so file contents / long output don't linger on the
      // screen -- the way Claude Code reports "⎿ Read 54 lines".
      const text = res.isError
        ? clipLine(body.split('\n')[0] ?? '', 200)
        : summariseResult(res.name, body);
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

          // Collapse the selector: erase the "Allow this action?" line and the
          // whole option list, then leave a single compact decision line in
          // their place -- the way Claude Code tidies up after a choice.
          // After draw() the cursor rests one line below the last option, so the
          // question sits (optionRows + 1) rows up.
          stdout.write(cursor.up(optionRows + 1));
          stdout.write('\r' + screen.clearDown);
          atLineStart = true;

          const decision = value === 'deny'
            ? red('✗ denied')
            : value === 'always'
              ? green("✓ allowed · won't ask again")
              : green('✓ allowed');
          emit('  ' + decision + '\n\n');

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
      const started = Date.now();
      stdout.write(cursor.hide);
      const tick = () => {
        const secs = Math.floor((Date.now() - started) / 1000);
        const elapsed = secs > 0 ? dim(`  ${secs}s`) : '';
        stdout.write(`\r${screen.clearLine}${accent(frames[i % frames.length])} ${accent('working')}${elapsed} ${dim('· Ctrl+C to interrupt')}`);
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

      // Refresh the autocomplete menu from the current buffer.
      const menu = computeMenu();
      menuKind = menu.kind;
      menuItems = menu.items;
      if (menuIndex >= menuItems.length) menuIndex = 0;

      clearRegion();

      const out = [];
      out.push(dim('╭' + '─'.repeat(width - 2) + '╮'));
      layout.rows.forEach((text, idx) => {
        const gutter = idx === 0 ? accent('❯ ') : '  ';
        // Empty buffer: show a dim placeholder; the cursor still parks at the
        // start of it, exactly where typing will begin.
        const body = (idx === 0 && editor.isEmpty)
          ? gutter + dim('Type a message, or / for commands')
          : gutter + text;
        out.push(dim('│') + ' ' + pad(body, width - 4) + ' ' + dim('│'));
      });
      out.push(dim('╰' + '─'.repeat(width - 2) + '╯'));
      out.push(statusLine(width));

      // The autocomplete dropdown renders below the status line. It sits after
      // the cursor row, so it never disturbs cursor placement inside the box.
      renderMenuInto(out);

      // Print without a trailing newline on the last row, so the hardware
      // cursor ends in a known spot we can move back from.
      stdout.write(out.join('\n'));

      regionRows = out.length;
      const targetRow = 1 + layout.cursorRow; // + top border
      const targetCol = 1 + 2 + 2 + layout.cursorCol; // "│ " + "❯ " + col
      const upBy = (regionRows - 1) - targetRow;
      if (upBy > 0) stdout.write(cursor.up(upBy));
      stdout.write('\r');
      if (targetCol > 1) stdout.write(cursor.toColumn(targetCol));
      cursorRowInRegion = targetRow;
    }

    /** The hint + live-status line under the input box, edge-justified. */
    function statusLine(width) {
      if (searchMode) {
        const hit = searchMode.matches[searchMode.idx] ?? '';
        return dim(`  bck-i-search: `) + `\`${searchMode.query}\`` + dim(hit ? `  →  ${hit}` : '  (no match)');
      }
      const left = dim('⏎ send   ⌥⏎ newline   / cmds   @ files   ! bash');
      const tokens = editor.value.trim()
        ? `${formatTokens(estimateTokens(editor.value))} tok`
        : '';
      const vimTag = state.vim ? (vim.mode === 'insert' ? green('-- INSERT --') : yellow('-- NORMAL --')) : '';
      const right = [
        vimTag,
        state.permissionMode !== 'default' ? state.permissionMode : '',
        state.model ?? 'default',
        state.raw ? red('raw') : green('compress'),
        `lean ${leanLabel(state.lean)}`,
        tokens,
      ].filter(Boolean).map((s) => dim(s)).join(dim('  ·  '));
      return justify('  ' + left, right + '  ', width);
    }

    /** Append the autocomplete rows (if any) to the render buffer. */
    function renderMenuInto(out) {
      if (!menuItems.length) return;
      for (let i = 0; i < menuItems.length; i += 1) {
        const c = menuItems[i];
        const active = i === menuIndex;
        const pointer = active ? accent('❯ ') : '  ';
        const name = menuKind === 'slash' ? `/${c.name}${c.arg ? ' ' + c.arg : ''}` : c.name;
        const label = active ? bold(name) : cyan(name);
        const hint = menuKind === 'slash' ? dim(c.hint ?? '') : '';
        out.push(clip('  ' + pointer + pad(label, 26) + hint, boxWidth()));
      }
      const legend = menuKind === 'file' ? '  ↑↓ choose · Tab/⏎ insert · Esc dismiss' : '  ↑↓ choose · ⏎ run · Tab complete · Esc dismiss';
      out.push(dim(legend));
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

/**
 * Collapse a tool result into a one-line action summary, à la Claude Code's
 * activity log -- so a Read doesn't dump the whole file into the transcript.
 * Content-heavy tools report a count; the rest show a trimmed first line.
 */
export function summariseResult(name, body = '') {
  const text = body.trim();
  const lines = text ? text.split('\n') : [];
  const n = lines.length;
  const L = (k) => `${k} line${k === 1 ? '' : 's'}`;

  switch (name) {
    case 'Read':
      return text ? `Read ${L(n)}` : 'Read (empty file)';
    case 'Grep':
      return text ? `Found ${L(n)}` : 'No matches';
    case 'Glob':
      return text ? `Found ${n} ${n === 1 ? 'file' : 'files'}` : 'No files';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return clipLine(lines[0] ?? '') || 'Done';
    default: {
      // Bash and unknown tools: the first line is usually the useful bit; note
      // how much more was hidden so nothing feels silently dropped.
      const head = clipLine(lines[0] ?? '') || '(no output)';
      return n > 1 ? `${head} (+${n - 1} more)` : head;
    }
  }
}

/** First line, hard-trimmed to `max` visible characters with an ellipsis. */
function clipLine(line, max = 200) {
  const s = String(line ?? '').replace(/\s+$/, '');
  return s.length > max ? s.slice(0, max) + '…' : s;
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

/** Place `left` at the start and `right` at the end of a `width`-wide line. */
function justify(left, right, width) {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) return clip(left, width); // too narrow: drop the status half
  return left + ' '.repeat(gap) + right;
}

/** Truncate to a visible `width`, but never pad. */
function clip(text, width) {
  return visibleWidth(text) > width ? truncateVisible(text, width) : text;
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
