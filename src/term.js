/**
 * Terminal control: raw-mode input, cursor/screen escapes, and key decoding.
 *
 * No dependencies -- this is the entire "TUI framework". The escape sequences
 * here are the standard ANSI/VT set that every modern terminal understands.
 */

const ESC = '\x1b';
const CSI = `${ESC}[`;

export const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  up: (n = 1) => `${CSI}${n}A`,
  down: (n = 1) => `${CSI}${n}B`,
  toColumn: (n = 1) => `${CSI}${n}G`,
  save: `${ESC}7`,
  restore: `${ESC}8`,
};

export const screen = {
  clear: `${CSI}2J${CSI}H`,
  clearLine: `${CSI}2K`,
  clearDown: `${CSI}0J`,
  toHome: `${CSI}H`,
};

/** Turn on bracketed paste so a multi-line paste arrives as one chunk. */
export const bracketedPaste = {
  on: `${CSI}?2004h`,
  off: `${CSI}?2004l`,
};

/**
 * Decode a raw input chunk into a stream of key events.
 *
 * Returns an array of { type, ... } so a single read (which may batch several
 * keystrokes, or a whole paste) is handled in order.
 */
export function decodeKeys(data) {
  const s = data.toString('utf8');
  const keys = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    // Bracketed paste: everything up to the end marker is literal text.
    if (s.startsWith('\x1b[200~', i)) {
      const end = s.indexOf('\x1b[201~', i);
      const body = end === -1 ? s.slice(i + 6) : s.slice(i + 6, end);
      keys.push({ type: 'paste', text: body });
      i = end === -1 ? s.length : end + 6;
      continue;
    }

    if (ch === '\x1b') {
      const consumed = decodeEscape(s, i, keys);
      i += consumed;
      continue;
    }

    // Control characters.
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      keys.push(decodeControl(code));
      i += 1;
      continue;
    }

    // Printable run: grab as many as possible at once.
    let j = i;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) !== 0x7f && s[j] !== '\x1b') {
      j += 1;
    }
    keys.push({ type: 'text', text: s.slice(i, j) });
    i = j;
  }

  return keys;
}

function decodeControl(code) {
  switch (code) {
    case 0x0d: // CR
    case 0x0a: // LF
      return { type: 'enter' };
    case 0x7f:
      return { type: 'backspace' };
    case 0x08:
      return { type: 'delete-word-back' };
    case 0x03:
      return { type: 'ctrl', key: 'c' };
    case 0x04:
      return { type: 'ctrl', key: 'd' };
    case 0x01:
      return { type: 'home' };
    case 0x05:
      return { type: 'end' };
    case 0x15:
      return { type: 'ctrl', key: 'u' };
    case 0x0b:
      return { type: 'ctrl', key: 'k' };
    case 0x17:
      return { type: 'ctrl', key: 'w' };
    case 0x0c:
      return { type: 'ctrl', key: 'l' };
    case 0x12:
      return { type: 'ctrl', key: 'r' };
    case 0x09:
      return { type: 'tab' };
    default:
      return { type: 'unknown', code };
  }
}

/** Parse an escape sequence starting at index i. Returns bytes consumed. */
function decodeEscape(s, i, keys) {
  // Alt+Enter arrives as ESC + CR -- our newline-insert chord.
  if (s[i + 1] === '\r' || s[i + 1] === '\n') {
    keys.push({ type: 'alt-enter' });
    return 2;
  }

  // Alt+Backspace arrives as ESC + DEL/BS -- delete the previous word.
  if (s[i + 1] === '\x7f' || s[i + 1] === '\x08') {
    keys.push({ type: 'delete-word-back' });
    return 2;
  }

  if (s[i + 1] === '[' || s[i + 1] === 'O') {
    const rest = s.slice(i + 2);

    // Shift+Tab (back-tab) arrives as ESC[Z -- used to cycle permission modes.
    if (rest[0] === 'Z') {
      keys.push({ type: 'shift-tab' });
      return 3;
    }

    // Letter-terminated keys: arrows and home/end. A modifier, when held,
    // shows up as a "1;<mod>" prefix -- e.g. ESC[1;5D is Ctrl+Left, ESC[1;3C
    // is Alt+Right. Plain ESC[D has no prefix.
    let m = rest.match(/^(?:(\d+);(\d+))?([ABCDHF])/);
    if (m) {
      const base = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }[m[3]];
      keys.push({ type: applyModifier(base, m[2]) });
      return 2 + m[0].length;
    }

    // Tilde-terminated keys carry the number first: ESC[3~ is Delete, and
    // ESC[3;5~ is Ctrl+Delete. Home/end also appear as ESC[1~ / ESC[4~.
    m = rest.match(/^(\d+)(?:;(\d+))?~/);
    if (m) {
      const base = { 1: 'home', 3: 'delete', 4: 'end', 7: 'home', 8: 'end' }[m[1]] ?? 'unknown';
      keys.push({ type: applyModifier(base, m[2]) });
      return 2 + m[0].length;
    }

    return 2; // Unknown CSI: swallow the introducer.
  }

  // A lone ESC.
  keys.push({ type: 'escape' });
  return 1;
}

/**
 * Fold a modifier code into a richer key type. The xterm modifier is a
 * bitmask offset by one: (mod-1) has bit 1 = shift, bit 2 = alt, bit 4 = ctrl.
 * Ctrl or Alt turns character moves into word moves and Delete into a word
 * delete; Ctrl+Home/End jump to the ends of the buffer.
 */
function applyModifier(base, modStr) {
  if (!modStr) return base;
  const bits = Number(modStr) - 1;
  const wordwise = (bits & 0b010) || (bits & 0b100); // alt or ctrl
  if (!wordwise) return base;
  switch (base) {
    case 'left': return 'word-left';
    case 'right': return 'word-right';
    case 'delete': return 'delete-word';
    case 'home': return 'doc-start';
    case 'end': return 'doc-end';
    default: return base;
  }
}

/** Visible width of a string, ignoring ANSI escapes. */
export function visibleWidth(str) {
  return stripAnsi(str).length;
}

export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
