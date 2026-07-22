/**
 * A practical vim mode over the LineEditor.
 *
 * Not a full vim -- a working core: normal/insert modes, the common motions
 * (h j k l w b e 0 ^ $ gg G), insert entries (i a I A o O), and the operators
 * people actually reach for (x r dd dw db D cc cw C). Counts, registers, and
 * visual mode are intentionally out of scope.
 *
 * Kept free of terminal I/O so the state machine is unit-testable: it mutates
 * the editor and its own {mode, pending} and reports what the caller should do.
 */

export function createVim() {
  return { mode: 'normal', pending: '' };
}

/**
 * @returns {{ handled: boolean, render?: boolean, submit?: boolean }}
 *   handled=false means "let the normal app editing run" (insert-mode typing).
 */
export function handleVimKey(key, editor, vim) {
  if (vim.mode === 'insert') {
    if (key.type === 'escape') {
      vim.mode = 'normal';
      editor.left(); // vim parks one char left when leaving insert
      return { handled: true, render: true };
    }
    return { handled: false }; // normal editing handles the rest
  }

  // --- normal mode ---
  switch (key.type) {
    case 'enter': return { handled: true, submit: true };
    case 'escape': vim.pending = ''; return { handled: true, render: true };
    case 'backspace': case 'left': editor.left(); return { handled: true, render: true };
    case 'right': editor.right(); return { handled: true, render: true };
    case 'up': editor.up(); return { handled: true, render: true };
    case 'down': editor.down(); return { handled: true, render: true };
    case 'text': for (const ch of key.text) step(ch, editor, vim); return { handled: true, render: true };
    default: return { handled: true, render: false };
  }
}

function step(ch, editor, vim) {
  if (vim.pending === 'r') { vim.pending = ''; if (editor.cursor < editor.value.length) { editor.del(); editor.insert(ch); editor.left(); } return; }
  if (vim.pending === 'g') { vim.pending = ''; if (ch === 'g') editor.docStart(); return; }
  if (vim.pending === 'd') {
    vim.pending = '';
    if (ch === 'd') deleteLine(editor);
    else if (ch === 'w') editor.deleteWordForward();
    else if (ch === 'b') editor.deleteWordBack();
    else if (ch === '$') editor.killToLineEnd();
    else if (ch === '0') editor.killToLineStart();
    return;
  }
  if (vim.pending === 'c') {
    vim.pending = '';
    if (ch === 'c') { clearLine(editor); vim.mode = 'insert'; }
    else if (ch === 'w') { editor.deleteWordForward(); vim.mode = 'insert'; }
    else if (ch === 'b') { editor.deleteWordBack(); vim.mode = 'insert'; }
    else if (ch === '$') { editor.killToLineEnd(); vim.mode = 'insert'; }
    return;
  }

  switch (ch) {
    case 'h': editor.left(); break;
    case 'l': editor.right(); break;
    case 'j': editor.down(); break;
    case 'k': editor.up(); break;
    case '0': case '^': editor.lineStart(); break;
    case '$': editor.lineEnd(); break;
    case 'w': case 'e': editor.wordRight(); break;
    case 'b': editor.wordLeft(); break;
    case 'x': editor.del(); break;
    case 'D': editor.killToLineEnd(); break;
    case 'G': editor.docEnd(); break;
    case 'g': vim.pending = 'g'; break;
    case 'd': vim.pending = 'd'; break;
    case 'c': vim.pending = 'c'; break;
    case 'r': vim.pending = 'r'; break;
    case 'i': vim.mode = 'insert'; break;
    case 'a': editor.right(); vim.mode = 'insert'; break;
    case 'I': editor.lineStart(); vim.mode = 'insert'; break;
    case 'A': editor.lineEnd(); vim.mode = 'insert'; break;
    case 'o': editor.lineEnd(); editor.newline(); vim.mode = 'insert'; break;
    case 'O': editor.lineStart(); editor.insert('\n'); editor.left(); vim.mode = 'insert'; break;
    case 'C': editor.killToLineEnd(); vim.mode = 'insert'; break;
    default: break;
  }
}

function deleteLine(editor) {
  editor.lineStart();
  editor.killToLineEnd();
  editor.del(); // pull up the following line, mimicking dd
}
function clearLine(editor) {
  editor.lineStart();
  editor.killToLineEnd();
}
