import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LineEditor } from '../src/editor.js';
import { decodeKeys } from '../src/term.js';
import { createVim, handleVimKey } from '../src/vim.js';
import { completePath, pathTokenAt, longestCommonPrefix } from '../src/complete.js';

// --- new key decodings -------------------------------------------------------

test('Shift+Tab decodes to shift-tab (ESC[Z)', () => {
  assert.equal(decodeKeys(Buffer.from('\x1b[Z'))[0].type, 'shift-tab');
});

test('Ctrl+R decodes to a ctrl r event', () => {
  assert.deepEqual(decodeKeys(Buffer.from('\x12'))[0], { type: 'ctrl', key: 'r' });
});

// --- completion engine -------------------------------------------------------

test('pathTokenAt extracts the path word ending at the cursor', () => {
  const v = 'edit src/au now';
  const { token, start } = pathTokenAt(v, 11); // caret right after "src/au"
  assert.equal(token, 'src/au');
  assert.equal(start, 5);
});

test('longestCommonPrefix finds the shared head', () => {
  assert.equal(longestCommonPrefix(['src/complete.js', 'src/compress.js']), 'src/comp');
  assert.equal(longestCommonPrefix([]), '');
});

test('completePath matches real files under cwd', () => {
  // Run from the project root; src/ holds complete.js and compress.js.
  const { matches, common } = completePath('src/comp', process.cwd());
  assert.ok(matches.includes('src/complete.js'));
  assert.ok(matches.includes('src/compress.js'));
  assert.equal(common, 'src/comp');
});

test('completePath marks directories with a trailing slash', () => {
  const { matches } = completePath('sr', process.cwd());
  assert.ok(matches.includes('src/'));
});

// --- vim mode ----------------------------------------------------------------

const txt = (t) => ({ type: 'text', text: t });

test('vim starts in normal mode and i enters insert', () => {
  const vim = createVim();
  const e = new LineEditor('hello');
  assert.equal(vim.mode, 'normal');
  const r = handleVimKey(txt('i'), e, vim);
  assert.equal(vim.mode, 'insert');
  assert.equal(r.handled, true);
});

test('vim insert mode passes typing through, Esc returns to normal', () => {
  const vim = createVim();
  const e = new LineEditor('');
  handleVimKey(txt('i'), e, vim);
  // In insert mode the engine defers to normal editing.
  assert.equal(handleVimKey(txt('x'), e, vim).handled, false);
  const r = handleVimKey({ type: 'escape' }, e, vim);
  assert.equal(vim.mode, 'normal');
  assert.equal(r.handled, true);
});

test('vim motions h/l/0/$ move the cursor', () => {
  const vim = createVim();
  const e = new LineEditor('hello');
  e.cursor = 5;
  handleVimKey(txt('0'), e, vim);
  assert.equal(e.cursor, 0);
  handleVimKey(txt('l'), e, vim);
  assert.equal(e.cursor, 1);
  handleVimKey(txt('$'), e, vim);
  assert.equal(e.cursor, 5);
});

test('vim x deletes a char, dw deletes a word, dd clears the line', () => {
  const vim = createVim();
  const e = new LineEditor('the quick brown');
  e.cursor = 0;
  handleVimKey(txt('x'), e, vim);
  assert.equal(e.value, 'he quick brown');
  handleVimKey(txt('d'), e, vim);
  handleVimKey(txt('w'), e, vim);
  // dw removes the word at the caret (boundary space is left — a documented
  // limit of this practical vim subset).
  assert.equal(e.value, ' quick brown');
  handleVimKey(txt('d'), e, vim);
  handleVimKey(txt('d'), e, vim);
  assert.equal(e.value, '');
});

test('vim A appends at line end in insert mode', () => {
  const vim = createVim();
  const e = new LineEditor('abc');
  e.cursor = 0;
  handleVimKey(txt('A'), e, vim);
  assert.equal(vim.mode, 'insert');
  assert.equal(e.cursor, 3);
});

test('vim Enter in normal mode signals submit', () => {
  const vim = createVim();
  const e = new LineEditor('run this');
  assert.equal(handleVimKey({ type: 'enter' }, e, vim).submit, true);
});
