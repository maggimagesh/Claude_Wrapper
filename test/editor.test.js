import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LineEditor } from '../src/editor.js';
import { decodeKeys } from '../src/term.js';
import { layoutInput, handleSlash, renderBanner, filterSlashCommands, summariseResult } from '../src/tui.js';

// --- editor: single line -----------------------------------------------------

test('typing appends and tracks the cursor', () => {
  const e = new LineEditor();
  e.insert('hello');
  assert.equal(e.value, 'hello');
  assert.equal(e.cursor, 5);
});

test('insert happens at the cursor, not the end', () => {
  const e = new LineEditor('helo');
  e.cursor = 3;
  e.insert('l');
  assert.equal(e.value, 'hello');
  assert.equal(e.cursor, 4);
});

test('backspace and delete', () => {
  const e = new LineEditor('cat');
  e.cursor = 2;
  e.backspace();
  assert.equal(e.value, 'ct');
  e.del();
  assert.equal(e.value, 'c');
});

test('word and line kills', () => {
  const e = new LineEditor('the quick brown');
  e.deleteWordBack();
  assert.equal(e.value, 'the quick ');

  const f = new LineEditor('keep this drop that');
  f.cursor = 10;
  f.killToLineEnd();
  assert.equal(f.value, 'keep this ');
  f.killToLineStart();
  assert.equal(f.value, '');
});

// --- editor: multi-line ------------------------------------------------------

test('newline creates a second line', () => {
  const e = new LineEditor('one');
  e.newline();
  e.insert('two');
  assert.equal(e.value, 'one\ntwo');
  assert.equal(e.lines().length, 2);
});

test('up and down move across lines keeping the column', () => {
  const e = new LineEditor('hello\nworld');
  e.cursor = 9; // 'wor|ld' -> col 3 on row 1
  assert.equal(e.up(), true);
  assert.deepEqual(e.rowCol(), { row: 0, col: 3 });
  assert.equal(e.down(), true);
  assert.deepEqual(e.rowCol(), { row: 1, col: 3 });
});

test('up returns false on the first line so history can take over', () => {
  const e = new LineEditor('single line');
  e.cursor = 3;
  assert.equal(e.up(), false);
});

test('down returns false on the last line', () => {
  const e = new LineEditor('a\nb');
  e.docEnd();
  assert.equal(e.down(), false);
});

test('home and end stay within the current visual line', () => {
  const e = new LineEditor('foo\nbarbaz');
  e.cursor = 7; // inside "barbaz"
  e.lineStart();
  assert.equal(e.cursor, 4);
  e.lineEnd();
  assert.equal(e.cursor, 10);
});

// --- key decoding ------------------------------------------------------------

test('printable text decodes as a single run', () => {
  assert.deepEqual(decodeKeys(Buffer.from('abc')), [{ type: 'text', text: 'abc' }]);
});

test('control keys decode to named actions', () => {
  assert.equal(decodeKeys(Buffer.from('\r'))[0].type, 'enter');
  assert.equal(decodeKeys(Buffer.from('\x7f'))[0].type, 'backspace');
  assert.deepEqual(decodeKeys(Buffer.from('\x03'))[0], { type: 'ctrl', key: 'c' });
});

test('arrow escape sequences decode', () => {
  assert.equal(decodeKeys(Buffer.from('\x1b[A'))[0].type, 'up');
  assert.equal(decodeKeys(Buffer.from('\x1b[D'))[0].type, 'left');
});

test('Ctrl+Left / Ctrl+Right decode to word moves, not literal text', () => {
  // ESC[1;5D and ESC[1;5C used to leak "1;5D"/"1;5C" into the buffer.
  const left = decodeKeys(Buffer.from('\x1b[1;5D'));
  assert.equal(left.length, 1);
  assert.equal(left[0].type, 'word-left');
  assert.equal(decodeKeys(Buffer.from('\x1b[1;5C'))[0].type, 'word-right');
  // Alt+Arrow (mod 3) is treated the same way.
  assert.equal(decodeKeys(Buffer.from('\x1b[1;3D'))[0].type, 'word-left');
});

test('Ctrl+Delete decodes to a forward word delete', () => {
  assert.equal(decodeKeys(Buffer.from('\x1b[3;5~'))[0].type, 'delete-word');
  // Plain Delete still decodes normally.
  assert.equal(decodeKeys(Buffer.from('\x1b[3~'))[0].type, 'delete');
});

test('Ctrl+Backspace and Alt+Backspace delete the previous word', () => {
  assert.equal(decodeKeys(Buffer.from('\x08'))[0].type, 'delete-word-back');
  assert.equal(decodeKeys(Buffer.from('\x1b\x7f'))[0].type, 'delete-word-back');
  // Plain Backspace (DEL) is unchanged.
  assert.equal(decodeKeys(Buffer.from('\x7f'))[0].type, 'backspace');
});

test('Ctrl+Home / Ctrl+End jump to the document ends', () => {
  assert.equal(decodeKeys(Buffer.from('\x1b[1;5H'))[0].type, 'doc-start');
  assert.equal(decodeKeys(Buffer.from('\x1b[1;5F'))[0].type, 'doc-end');
});

// --- editor: word motions ----------------------------------------------------

test('wordLeft / wordRight hop over whole words', () => {
  const e = new LineEditor('the quick brown fox');
  e.cursor = 19; // end
  e.wordLeft();
  assert.equal(e.cursor, 16); // start of "fox"
  e.wordLeft();
  assert.equal(e.cursor, 10); // start of "brown"
  e.wordRight();
  assert.equal(e.cursor, 15); // end of "brown"
});

test('deleteWordForward removes the word ahead of the cursor', () => {
  const e = new LineEditor('the quick brown');
  e.cursor = 0;
  e.deleteWordForward();
  assert.equal(e.value, ' quick brown');
  assert.equal(e.cursor, 0);
});

test('Alt+Enter is the newline chord, distinct from Enter', () => {
  assert.equal(decodeKeys(Buffer.from('\x1b\r'))[0].type, 'alt-enter');
  assert.equal(decodeKeys(Buffer.from('\r'))[0].type, 'enter');
});

test('bracketed paste is captured as one text event, newlines intact', () => {
  const keys = decodeKeys(Buffer.from('\x1b[200~line1\nline2\x1b[201~'));
  assert.equal(keys.length, 1);
  assert.equal(keys[0].type, 'paste');
  assert.equal(keys[0].text, 'line1\nline2');
});

// --- input layout ------------------------------------------------------------

test('a short line is one row, cursor at the end', () => {
  const { rows, cursorRow, cursorCol } = layoutInput('hello', 5, 20);
  assert.deepEqual(rows, ['hello']);
  assert.equal(cursorRow, 0);
  assert.equal(cursorCol, 5);
});

test('a long line wraps and the cursor follows onto the next row', () => {
  const { rows, cursorRow, cursorCol } = layoutInput('abcdefghij', 8, 4);
  assert.deepEqual(rows, ['abcd', 'efgh', 'ij']);
  assert.equal(cursorRow, 2);
  assert.equal(cursorCol, 0);
});

test('explicit newlines produce separate rows', () => {
  const { rows, cursorRow } = layoutInput('a\nb\nc', 4, 20);
  assert.deepEqual(rows, ['a', 'b', 'c']);
  assert.equal(cursorRow, 2);
});

test('an empty buffer still renders one row', () => {
  assert.deepEqual(layoutInput('', 0, 20).rows, ['']);
});

// --- slash commands ----------------------------------------------------------

test('/lean toggles the lean setting', () => {
  const state = { lean: 'auto' };
  handleSlash('/lean', state);
  assert.equal(state.lean, true);
  handleSlash('/lean off', state);
  assert.equal(state.lean, false);
  handleSlash('/lean auto', state);
  assert.equal(state.lean, 'auto');
});

test('/raw toggles compression', () => {
  const state = { raw: false };
  handleSlash('/raw', state);
  assert.equal(state.raw, true);
});

test('/reply validates its argument', () => {
  const state = { reply: 'terse' };
  assert.match(handleSlash('/reply loud', state).note, /usage/);
  assert.equal(state.reply, 'terse');
  handleSlash('/reply normal', state);
  assert.equal(state.reply, 'normal');
});

test('/exit signals exit; unknown commands do not', () => {
  assert.equal(handleSlash('/exit', {}).exit, true);
  assert.equal(handleSlash('/bogus', {}).exit, undefined);
});

// --- slash autocomplete ------------------------------------------------------

test('filterSlashCommands matches by prefix', () => {
  assert.deepEqual(filterSlashCommands('/l').map((c) => c.name), ['lean']);
  const names = filterSlashCommands('/').map((c) => c.name);
  assert.ok(names.includes('help') && names.includes('exit'));
});

test('filterSlashCommands hides once an argument is being typed', () => {
  assert.deepEqual(filterSlashCommands('/model '), []);
  assert.deepEqual(filterSlashCommands('/model opus'), []);
  assert.deepEqual(filterSlashCommands('hello'), []);
});

// --- tool result summaries ---------------------------------------------------

test('summariseResult collapses a Read to a line count, not file content', () => {
  const file = '1\timport x\n2\tconst y = 1\n3\treturn y';
  assert.equal(summariseResult('Read', file), 'Read 3 lines');
  assert.equal(summariseResult('Read', 'only one line'), 'Read 1 line');
  assert.equal(summariseResult('Read', ''), 'Read (empty file)');
});

test('summariseResult counts Grep/Glob hits', () => {
  assert.equal(summariseResult('Grep', 'a\nb'), 'Found 2 lines');
  assert.equal(summariseResult('Glob', 'one.ts'), 'Found 1 file');
  assert.equal(summariseResult('Grep', ''), 'No matches');
});

test('summariseResult keeps a short first line for Bash and notes the rest', () => {
  assert.equal(summariseResult('Bash', 'done'), 'done');
  assert.equal(summariseResult('Bash', 'line1\nline2\nline3'), 'line1 (+2 more)');
});

test('the banner renders without color codes leaking width', () => {
  const banner = renderBanner({ reply: 'terse', model: null, lean: 'auto', raw: false });
  assert.ok(banner.includes('claudecode-wrapper'));
  assert.ok(banner.includes('/help'));
});
