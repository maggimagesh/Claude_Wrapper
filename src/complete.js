/**
 * Filesystem path completion, used by both Tab-completion and @file mentions.
 *
 * Pure enough to test: given a typed fragment and a base directory, it returns
 * the candidate paths and their longest common prefix. Directories come back
 * with a trailing '/', hidden entries only when the fragment already reaches
 * for them -- the conventions every shell completion follows.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, basename, join, isAbsolute } from 'node:path';

/**
 * @param {string} fragment  partial path, e.g. "src/te" or "src/" or "".
 * @param {string} cwd
 * @returns {{ matches: string[], common: string }}
 */
export function completePath(fragment, cwd = process.cwd()) {
  const endsSlash = fragment.endsWith('/');
  const base = endsSlash ? '' : basename(fragment);
  // The part the user typed before the basename -- kept verbatim so the
  // completion slots back in exactly where it came from.
  const prefix = fragment.slice(0, fragment.length - base.length);

  const dirPart = endsSlash ? fragment.slice(0, -1) : dirname(fragment);
  const searchDir = !dirPart || dirPart === '.'
    ? (fragment.startsWith('./') ? join(cwd, '.') : cwd)
    : (isAbsolute(dirPart) ? dirPart : join(cwd, dirPart));

  let entries;
  try {
    entries = readdirSync(searchDir);
  } catch {
    return { matches: [], common: fragment };
  }

  const wantHidden = base.startsWith('.');
  const matches = [];
  for (const name of entries) {
    if (!name.startsWith(base)) continue;
    if (!wantHidden && name.startsWith('.')) continue;
    let isDir = false;
    try { isDir = statSync(join(searchDir, name)).isDirectory(); } catch { /* ignore */ }
    matches.push(prefix + name + (isDir ? '/' : ''));
  }
  matches.sort();

  return { matches, common: longestCommonPrefix(matches) || fragment };
}

/** The word (path-ish run) ending at `cursor`, and where it starts. */
export function pathTokenAt(value, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  return { token: value.slice(start, cursor), start };
}

export function longestCommonPrefix(strings) {
  if (!strings.length) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}
