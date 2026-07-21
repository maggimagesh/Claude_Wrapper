/**
 * Terminal output.
 *
 * Colour is written directly rather than pulled from a dependency, and is
 * suppressed when stdout is not a TTY or NO_COLOR is set, so piped output stays
 * clean.
 */

import { formatTokens, reduction } from './tokens.js';

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (open, close) => (text) => (enabled ? `[${open}m${text}[${close}m` : text);

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

export function out(text = '') {
  process.stdout.write(`${text}\n`);
}

export function err(text = '') {
  process.stderr.write(`${text}\n`);
}

/** Show the compressed prompt as it will be sent. */
export function showPrompt(result) {
  err(dim('┌ caveman'));
  for (const line of result.prompt.split('\n')) {
    err(dim('│ ') + cyan(line));
  }
  err(dim('└'));
}

/**
 * Savings line.
 *
 * `real` is the input-token count the CLI reported for this call. It includes
 * the system prompt, tool definitions, and any files Claude read -- overhead
 * the wrapper does not control -- so it is shown separately from the prompt-level
 * figure rather than folded into it.
 */
export function showStats({ before, after, real, cost, durationMs, lean }) {
  const pct = reduction(before, after);
  const colour = pct >= 60 ? green : pct >= 30 ? yellow : dim;

  const parts = [
    `prompt ${formatTokens(before)} -> ${formatTokens(after)} est tokens`,
    colour(`-${pct}%`),
  ];

  if (real != null) parts.push(dim(`| ${formatTokens(real)} in total`));
  if (lean) parts.push(green('| lean'));
  if (cost != null) parts.push(dim(`| $${cost.toFixed(4)}`));
  if (durationMs != null) parts.push(dim(`| ${(durationMs / 1000).toFixed(1)}s`));

  err(dim('· ') + parts.join(' '));
}

/** Side-by-side dry-run report. */
export function showDryRun(result) {
  const pct = reduction(result.before, result.after);

  err(bold('raw') + dim(` (${result.before} est tokens)`));
  err(result.rawText);
  err('');
  err(bold('caveman') + dim(` (${result.after} est tokens, -${pct}%)`));
  out(result.prompt);
  err('');
  err(dim(`intent: ${result.intent.action}`) +
    (result.intent.constraints.length
      ? dim(` | constraints: ${result.intent.constraints.map((c) => c.kind).join(',')}`)
      : ''));
}
