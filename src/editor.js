/**
 * A multi-line text buffer with a cursor.
 *
 * Pure state: it knows nothing about the terminal, raw mode, or escape codes.
 * The TUI feeds it decoded actions ("insert x", "backspace", "up") and asks it
 * to render. Keeping it free of I/O is what makes the multi-line editing logic
 * testable without a live TTY -- see test/editor.test.js.
 *
 * The buffer is a single string; line breaks are literal '\n'. The cursor is a
 * character offset in [0, length].
 */

export class LineEditor {
  constructor(value = '') {
    this.value = value;
    this.cursor = value.length;
    /** Remembered column for vertical moves, so up/down keeps its lane. */
    this.goalColumn = null;
  }

  get isEmpty() {
    return this.value.length === 0;
  }

  get isMultiline() {
    return this.value.includes('\n');
  }

  clear() {
    this.value = '';
    this.cursor = 0;
    this.goalColumn = null;
  }

  setValue(value, cursor = value.length) {
    this.value = value;
    this.cursor = Math.max(0, Math.min(cursor, value.length));
    this.goalColumn = null;
  }

  insert(text) {
    if (!text) return;
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.goalColumn = null;
  }

  newline() {
    this.insert('\n');
  }

  backspace() {
    if (this.cursor === 0) return;
    this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
    this.cursor -= 1;
    this.goalColumn = null;
  }

  del() {
    if (this.cursor >= this.value.length) return;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
    this.goalColumn = null;
  }

  left() {
    if (this.cursor > 0) this.cursor -= 1;
    this.goalColumn = null;
  }

  right() {
    if (this.cursor < this.value.length) this.cursor += 1;
    this.goalColumn = null;
  }

  /** Start of the current visual line. */
  lineStart() {
    this.cursor = this.value.lastIndexOf('\n', this.cursor - 1) + 1;
    this.goalColumn = null;
  }

  /** End of the current visual line. */
  lineEnd() {
    const next = this.value.indexOf('\n', this.cursor);
    this.cursor = next === -1 ? this.value.length : next;
    this.goalColumn = null;
  }

  docStart() {
    this.cursor = 0;
    this.goalColumn = null;
  }

  docEnd() {
    this.cursor = this.value.length;
    this.goalColumn = null;
  }

  killToLineStart() {
    const start = this.value.lastIndexOf('\n', this.cursor - 1) + 1;
    this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
    this.cursor = start;
    this.goalColumn = null;
  }

  killToLineEnd() {
    const next = this.value.indexOf('\n', this.cursor);
    const end = next === -1 ? this.value.length : next;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(end);
    this.goalColumn = null;
  }

  deleteWordBack() {
    if (this.cursor === 0) return;
    const i = this.wordBoundaryBack();
    this.value = this.value.slice(0, i) + this.value.slice(this.cursor);
    this.cursor = i;
    this.goalColumn = null;
  }

  deleteWordForward() {
    if (this.cursor >= this.value.length) return;
    const i = this.wordBoundaryForward();
    this.value = this.value.slice(0, this.cursor) + this.value.slice(i);
    this.goalColumn = null;
  }

  /** Move the cursor to the start of the word to the left (Ctrl+Left). */
  wordLeft() {
    this.cursor = this.wordBoundaryBack();
    this.goalColumn = null;
  }

  /** Move the cursor to the end of the word to the right (Ctrl+Right). */
  wordRight() {
    this.cursor = this.wordBoundaryForward();
    this.goalColumn = null;
  }

  /** Offset of the word boundary before the cursor: skip spaces, then a word. */
  wordBoundaryBack() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.value[i - 1])) i -= 1;
    while (i > 0 && !/\s/.test(this.value[i - 1])) i -= 1;
    return i;
  }

  /** Offset of the word boundary after the cursor: skip spaces, then a word. */
  wordBoundaryForward() {
    let i = this.cursor;
    const n = this.value.length;
    while (i < n && /\s/.test(this.value[i])) i += 1;
    while (i < n && !/\s/.test(this.value[i])) i += 1;
    return i;
  }

  /**
   * Move up one visual line, keeping the column. Returns false when already on
   * the first line, so the caller can fall back to history.
   */
  up() {
    const { row, col } = this.rowCol();
    if (row === 0) return false;
    const lines = this.value.split('\n');
    const target = this.goalColumn ?? col;
    const goal = Math.min(target, lines[row - 1].length);
    this.cursor = this.offsetOf(lines, row - 1, goal);
    this.goalColumn = target;
    return true;
  }

  /**
   * Move down one visual line. Returns false when already on the last line.
   */
  down() {
    const { row, col } = this.rowCol();
    const lines = this.value.split('\n');
    if (row >= lines.length - 1) return false;
    const target = this.goalColumn ?? col;
    const goal = Math.min(target, lines[row + 1].length);
    this.cursor = this.offsetOf(lines, row + 1, goal);
    this.goalColumn = target;
    return true;
  }

  /** Cursor position as { row, col } over the newline-split lines. */
  rowCol() {
    const before = this.value.slice(0, this.cursor);
    const row = (before.match(/\n/g) ?? []).length;
    const col = before.length - (before.lastIndexOf('\n') + 1);
    return { row, col };
  }

  /** Offset of (row, col) back into the flat buffer. */
  offsetOf(lines, row, col) {
    let offset = 0;
    for (let i = 0; i < row; i += 1) offset += lines[i].length + 1; // + '\n'
    return offset + col;
  }

  lines() {
    return this.value.split('\n');
  }
}
