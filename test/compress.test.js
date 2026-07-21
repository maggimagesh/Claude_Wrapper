import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compress } from '../src/compress.js';
import { protect, restore } from '../src/protect.js';
import { classify } from '../src/intent.js';
import { estimateTokens, reduction } from '../src/tokens.js';
import { buildArgs, pickLean } from '../src/claude.js';

// --- protection: the things that must survive byte-for-byte ------------------

test('fenced code blocks survive untouched', () => {
  const raw = 'please fix this:\n```js\nconst theValue = a.b(1);\n```\nthanks';
  const { prompt } = compress(raw);
  assert.ok(prompt.includes('const theValue = a.b(1);'));
});

test('file paths are preserved exactly', () => {
  for (const path of ['src/auth/login.js', './lib/util.ts', '/etc/hosts', 'a_b.py']) {
    const { prompt } = compress(`could you please look at ${path} for me, thanks`);
    assert.ok(prompt.includes(path), `lost ${path} -> ${prompt}`);
  }
});

test('identifiers are not stemmed or lowercased', () => {
  const { prompt } = compress('the getUserSettings function is failing, please fix it');
  assert.ok(prompt.includes('getUserSettings'), prompt);
});

test('quoted strings and URLs survive', () => {
  const { prompt } = compress('it logs "Cannot read the property" see https://ex.com/a?b=1');
  assert.ok(prompt.includes('"Cannot read the property"'), prompt);
  assert.ok(prompt.includes('https://ex.com/a?b=1'), prompt);
});

test('protect/restore round-trips to the original', () => {
  const raw = 'run `npm test` on src/a.js then GET https://x.io v1.2.3 --force';
  const { masked, spans } = protect(raw);
  assert.equal(restore(masked, spans), raw);
});

// --- negation: dropping one of these inverts the request ---------------------

test('negations are never dropped', () => {
  // Case-insensitive: a negation hoisted into a REQ line is upper-cased
  // ("NO change public api"), which preserves the meaning either way.
  const cases = [
    ['do not use recursion here at all', /\bno(?:t)?\b/i],
    ["don't touch the public API please", /\bno(?:t)?\b/i],
    ['refactor it but without changing behaviour', /\bwithout\b/i],
    ['only update the tests, nothing else', /\bonly\b/i],
    ['never log the token value', /\b(?:never|no|not)\b/i],
  ];
  for (const [raw, expected] of cases) {
    const { prompt } = compress(raw);
    assert.match(prompt, expected, `negation lost in: ${raw} -> ${prompt}`);
  }
});

// --- compression: does it actually reduce ------------------------------------

test('a verbose polite prompt drops by at least 60%', () => {
  const raw = `Hey there! I was wondering if you could possibly help me out with
    something. So basically, I have this function in my code and I think it might
    be causing some issues. It would be really great if you could take a look at it
    when you get a chance and let me know what you think. Thanks so much in advance,
    I really appreciate the help!`;
  const { before, after } = compress(raw);
  assert.ok(reduction(before, after) >= 60, `only ${reduction(before, after)}%`);
});

test('an already-terse prompt is not inflated', () => {
  const raw = 'fix login bug';
  const { before, after } = compress(raw);
  assert.ok(after <= before + 2, `${before} -> ${after}`);
});

test('filler words are stripped', () => {
  const { prompt } = compress('so basically I just really need you to actually fix the parser');
  for (const filler of ['basically', 'really', 'actually', 'just']) {
    assert.ok(!prompt.toLowerCase().includes(filler), `kept "${filler}": ${prompt}`);
  }
  assert.ok(prompt.toLowerCase().includes('parser'), prompt);
});

test('emoji and markdown decoration are removed', () => {
  const { prompt } = compress('## Task 🚀\n- **fix** the parser\n- add tests ✅');
  assert.ok(!/[🚀✅#*]/.test(prompt), prompt);
});

// --- slots -------------------------------------------------------------------

test('forcing slots emits the full structure', () => {
  const raw = `the authentication middleware in src/middleware/auth.js keeps
    rejecting valid tokens after the refresh flow completes, and I need it fixed
    without changing the public interface of the module`;
  const { prompt } = compress(raw, { slots: true });
  assert.match(prompt, /^DO /m);
  assert.match(prompt, /^WANT /m);
  assert.match(prompt, /^REQ /m);
});

test('short prompts stay on one line', () => {
  assert.ok(!compress('fix typo').prompt.includes('\n'));
});

// The adaptive path buys structure only when it is cheap. Whichever form it
// picks, the result must never be longer than the prompt it replaced -- a
// wrapper that inflates prompts has failed at its stated purpose.
test('compression never inflates a prompt', () => {
  const prompts = [
    'add retry logic to src/fetch.js, do not break the public API',
    'fix login bug',
    'what is a closure?',
    'refactor the parser but keep the behaviour identical',
    'why does the test suite hang on CI but not locally?',
  ];
  for (const raw of prompts) {
    const { before, after } = compress(raw);
    assert.ok(after <= before, `inflated ${before} -> ${after}: ${raw}`);
  }
});

test('slots can be forced off', () => {
  const raw = 'the authentication middleware in src/middleware/auth.js rejects valid tokens after refresh and needs a fix';
  const { prompt } = compress(raw, { slots: false });
  assert.ok(!prompt.includes('\nWANT'), prompt);
});

// --- intent ------------------------------------------------------------------

test('actions are classified', () => {
  const cases = [
    ['the build is crashing on startup', 'FIX'],
    ['write unit tests for the parser', 'TEST'],
    ['what does this regex do?', 'EXPLAIN'],
    ['clean up this module', 'REFACTOR'],
    ['where is the config loaded?', 'FIND'],
    ['this endpoint is really slow', 'OPTIMIZE'],
    ['should we use redis or postgres?', 'ADVISE'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(classify(raw).action, expected, `${raw} -> ${classify(raw).action}`);
  }
});

test('constraints are captured with their kind', () => {
  const { constraints } = classify('add caching but do not change the schema, and only use redis');
  const kinds = constraints.map((c) => c.kind);
  assert.ok(kinds.includes('NO'), JSON.stringify(constraints));
  assert.ok(kinds.includes('ONLY'), JSON.stringify(constraints));
});

test('deliverable is inferred when unstated', () => {
  const { prompt } = compress(
    `the authentication middleware in src/middleware/auth.js keeps
     rejecting perfectly valid tokens whenever the refresh flow finishes running`,
    { slots: true },
  );
  assert.match(prompt, /WANT .*patch/);
});

// --- tokens ------------------------------------------------------------------

test('token estimates grow with length and punctuation', () => {
  assert.ok(estimateTokens('hello world') < estimateTokens('hello world again and again'));
  assert.ok(estimateTokens('a b c') < estimateTokens('a!@#$%^&*() b'));
  assert.equal(estimateTokens(''), 0);
});

test('reduction is clamped to a sane range', () => {
  assert.equal(reduction(100, 10), 90);
  assert.equal(reduction(10, 100), 0);
  assert.equal(reduction(0, 5), 0);
});

// --- CLI wiring --------------------------------------------------------------

test('args target the local CLI and never carry credentials', () => {
  const args = buildArgs({ model: 'opus', reply: 'terse' });
  assert.ok(args.includes('--print'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ['--output-format', 'json']);
  assert.ok(args.includes('--model'));
  const joined = args.join(' ');
  assert.ok(!/api[-_ ]?key|token|secret|credential/i.test(joined), joined);
});

test('streaming switches the output format', () => {
  const args = buildArgs({ stream: true });
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--include-partial-messages'));
});

// --- lean mode ---------------------------------------------------------------
// Tool schemas, not prompt text, are the bulk of a turn's input tokens, so this
// is where the savings actually come from. It must never strip tools from a
// request that needs to read the repo.

test('knowledge questions run without tools', () => {
  const { intent, subjects } = compress('what is a closure in JavaScript?');
  assert.equal(pickLean(intent, subjects), true);
});

test('anything naming a file keeps its tools', () => {
  for (const raw of [
    'explain what src/auth.js does',
    'explain the logic in ./lib/parse.py',
  ]) {
    const { intent, subjects } = compress(raw);
    assert.equal(pickLean(intent, subjects), false, raw);
  }
});

test('actions that touch the repo keep their tools', () => {
  for (const raw of [
    'add a retry helper',
    'the build is crashing',
    'write tests for the parser',
    'refactor this module',
  ]) {
    const { intent, subjects } = compress(raw);
    assert.equal(pickLean(intent, subjects), false, raw);
  }
});

test('lean can be forced either way', () => {
  const { intent, subjects } = compress('add a retry helper');
  assert.equal(pickLean(intent, subjects, true), true);
  assert.equal(pickLean(intent, subjects, false), false);
});

test('lean mode disables tools in the child args', () => {
  const args = buildArgs({ lean: true });
  const i = args.indexOf('--tools');
  assert.ok(i !== -1);
  assert.equal(args[i + 1], '');
  assert.ok(!buildArgs({ lean: false }).includes('--tools'));
});

test('passthrough args land at the end', () => {
  const args = buildArgs({ passthrough: ['--foo', 'bar'] });
  assert.deepEqual(args.slice(-2), ['--foo', 'bar']);
});
