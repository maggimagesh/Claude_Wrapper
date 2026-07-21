/**
 * Token estimation.
 *
 * Used for dry runs and for the "before" side of the savings figure, where no
 * real API call happens and therefore no real count exists. Actual runs report
 * the counts the CLI returns in its usage block -- see claude.js. Anything
 * derived from this file is labelled "est" in the UI, because it is.
 *
 * Approach: BPE splits common whole words into one token and rarer or longer
 * words into several, so word length is the dominant signal. Punctuation and
 * symbols are usually their own token, which is exactly why symbol-heavy
 * prompts cost more than their character count suggests.
 */

const WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
const NUMBER_RE = /\d+/g;
const SYMBOL_RE = /[^\sA-Za-z\d]/g;

/**
 * Estimate the token count of a string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;

  let total = 0;

  // Words: up to ~4 characters is typically a single token; longer words split
  // roughly every 4 characters after that.
  for (const word of text.match(WORD_RE) ?? []) {
    total += word.length <= 4 ? 1 : Math.ceil(word.length / 4);
  }

  // Digit runs tokenise in groups of about three.
  for (const run of text.match(NUMBER_RE) ?? []) {
    total += Math.ceil(run.length / 3);
  }

  // Symbols are near-always standalone tokens.
  total += (text.match(SYMBOL_RE) ?? []).length;

  // Newlines carry a token each; runs of spaces usually fold into neighbours.
  total += (text.match(/\n/g) ?? []).length;

  return Math.max(1, total);
}

/** Format a token count for display. */
export function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Percentage reduction from `before` to `after`, clamped to [0, 100].
 */
export function reduction(before, after) {
  if (!before) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - after / before) * 100)));
}
