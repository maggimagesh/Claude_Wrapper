/**
 * The single place all user-facing text styling goes through.
 *
 * Two responsibilities:
 *   1. renderMarkdown() -- turn the markdown that Claude emits (**bold**, `code`,
 *      # headers, lists, blockquotes, fenced code) into real terminal styling,
 *      via marked + marked-terminal rather than hand-rolled regex.
 *   2. Semantic colour helpers (error/warn/success/info/muted) so status text
 *      across the CLI reads consistently, à la git / npm / Claude Code.
 *
 * Colour is suppressed when stdout is not a TTY or NO_COLOR is set; in that mode
 * markdown is still structurally rendered (asterisks/backticks removed, headers
 * on their own lines) but stripped of every ANSI escape, so piped or redirected
 * output stays clean and greppable.
 */

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import {
  dim, bold, red, green, yellow, cyan, accent,
} from './render.js';
import { stripAnsi } from './term.js';

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

// Terminal italic has no helper in render.js; emit the SGR pair directly. It is
// stripped along with everything else when colour is disabled.
const italic = (s) => `\x1b[3m${s}\x1b[23m`;

let configured = false;
function ensureConfigured() {
  if (configured) return;
  marked.use(markedTerminal({
    // Theme the block elements to match the wrapper's accent palette. These
    // functions are the render.js helpers, which already no-op when colour is
    // off, so they double as the plain-text path.
    firstHeading: (s) => bold(accent(s)),
    heading: (s) => bold(cyan(s)),
    codespan: (s) => yellow(s),
    blockquote: (s) => dim(s),
    strong: bold,
    em: italic,
    link: (s) => cyan(s),
    href: (s) => cyan(s),
    // Keep code blocks and lists on marked-terminal's defaults (syntax
    // highlighting via cli-highlight, bulleted/numbered lists), and don't
    // reflow prose -- the terminal wraps it and reflow would fight our layout.
    reflowText: false,
    tab: 2,
    unescape: true,
  }));
  configured = true;
}

/**
 * Render a markdown string to ANSI-styled terminal text. Safe on partial or
 * malformed markdown (falls back to the raw text). Trailing blank lines are
 * trimmed so callers control their own spacing.
 */
export function renderMarkdown(md) {
  const text = String(md ?? '');
  if (!text.trim()) return '';
  ensureConfigured();

  let out;
  try {
    out = marked.parse(text, { async: false });
  } catch {
    out = text; // never let a formatting failure swallow the model's answer
  }
  if (typeof out !== 'string') out = text;

  out = out.replace(/\s+$/, '');
  // Guarantee no ANSI leaks into pipes / files / NO_COLOR, regardless of what
  // marked-terminal's bundled chalk decided.
  if (!colorEnabled) out = stripAnsi(out);
  return out;
}

// --- semantic colour helpers -------------------------------------------------
// One vocabulary for status text everywhere: red = error, yellow = warning,
// green = success, cyan = info, gray = muted/secondary.

export const error = (s) => red(s);
export const warn = (s) => yellow(s);
export const success = (s) => green(s);
export const info = (s) => cyan(s);
export const muted = (s) => dim(s);

/** True when ANSI styling is active (TTY and NO_COLOR unset). */
export const isStyled = colorEnabled;
