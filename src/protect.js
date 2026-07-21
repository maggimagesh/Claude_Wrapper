/**
 * Span protection.
 *
 * Compression rewrites natural language aggressively. Anything that is not
 * natural language -- code, paths, identifiers, error strings -- must survive
 * byte-for-byte, because a mangled identifier makes the whole prompt wrong in a
 * way the model cannot recover from.
 *
 * Strategy: lift such spans out into a table, leave a sentinel behind, run the
 * language passes over what remains, then splice the originals back in.
 *
 * Sentinels are <index>. They contain no whitespace and no letters,
 * so they never match a stopword, never get lowercased into something else, and
 * never get suffix-stripped.
 */

const OPEN = '';
const CLOSE = '';

export const SENTINEL_RE = /(\d+)/g;

/** True if the token is a protected-span placeholder. */
export function isSentinel(token) {
  return token.includes(OPEN);
}

/**
 * Ordered most-specific-first. Order matters: a fenced code block may contain
 * URLs and quotes, so it has to be lifted before they are considered.
 */
const PATTERNS = [
  // Fenced code blocks, including unterminated ones (a prompt pasted mid-edit).
  { kind: 'code', re: /```[\s\S]*?(?:```|$)/g },
  // Note: there is deliberately no rule for indented (unfenced) code blocks.
  // Distinguishing them from wrapped prose needs a heuristic, and a false
  // positive silently exempts the whole prompt from compression -- the tool
  // failing at its one job. Unfenced code still keeps its identifiers, paths,
  // strings, and numbers via the per-token rules below; only its layout is lost.
  // Fence code blocks to preserve them verbatim.
  // Inline code.
  { kind: 'code', re: /`[^`\n]+`/g },
  // URLs.
  { kind: 'url', re: /\bhttps?:\/\/[^\s<>()"']+/g },
  // Quoted strings -- usually literal values or error text.
  { kind: 'quote', re: /"[^"\n]{1,200}"|'[^'\n]{1,200}'/g },
  // Absolute and relative paths.
  { kind: 'path', re: /(?:^|(?<=\s))(?:\.{0,2}\/)[\w.@/-]+/g },
  // Filenames with a recognisable extension.
  {
    kind: 'path',
    re: /\b[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|swift|sh|bash|zsh|sql|json|jsonc|ya?ml|toml|ini|env|xml|html|css|scss|less|md|mdx|txt|lock|log|csv|proto|graphql|tf|dockerfile)\b/gi,
  },
  // CLI flags.
  { kind: 'flag', re: /(?:^|(?<=\s))--?[a-zA-Z][\w-]*/g },
  // Environment / constant style identifiers.
  { kind: 'ident', re: /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b|\b[A-Z]{4,}\b/g },
  // Function calls and member access: foo(), a.b.c, obj.method()
  { kind: 'ident', re: /\b\w+(?:\.\w+)+(?:\(\))?|\b\w+\(\)/g },
  // camelCase / PascalCase / snake_case identifiers.
  { kind: 'ident', re: /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b\w+_\w+\b/g },
  // Versions, hex, numbers with units, HTTP codes.
  { kind: 'num', re: /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b|\b0x[0-9a-fA-F]+\b|\b\d+(?:ms|s|m|h|kb|mb|gb|tb|px|%)\b/gi },
  // @scope/package and #123 issue refs.
  { kind: 'ident', re: /@[\w-]+\/[\w-]+|(?:^|(?<=\s))#\d+\b/g },
];

/**
 * Lift protected spans out of `text`.
 * @returns {{ masked: string, spans: string[] }}
 */
export function protect(text) {
  const spans = [];
  let masked = text;

  for (const { re } of PATTERNS) {
    masked = masked.replace(new RegExp(re.source, re.flags), (match) => {
      // Never nest: if the match is already only sentinels/whitespace, skip it.
      if (!match.trim() || /^[\d\s]+$/.test(match)) return match;
      // Preserve any leading whitespace the lookbehind-free patterns captured.
      const lead = match.match(/^\s*/)[0];
      const body = match.slice(lead.length);
      if (!body) return match;
      const index = spans.push(body) - 1;
      return `${lead}${OPEN}${index}${CLOSE}`;
    });
  }

  return { masked, spans };
}

/** Splice protected spans back into compressed text. */
export function restore(masked, spans) {
  return masked.replace(SENTINEL_RE, (whole, index) => {
    const span = spans[Number(index)];
    return span === undefined ? whole : span;
  });
}

/**
 * Spans worth naming as explicit subjects of the prompt -- paths and
 * identifiers, not prose quotes or long code blocks.
 */
export function subjectSpans(spans) {
  const seen = new Set();
  const out = [];
  for (const span of spans) {
    if (span.length > 60 || span.startsWith('```')) continue;
    if (/^["']/.test(span)) continue;
    const key = span.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(span);
  }
  return out;
}
