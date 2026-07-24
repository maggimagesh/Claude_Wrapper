/**
 * The compression pipeline.
 *
 *   raw prompt
 *     -> protect non-language spans
 *     -> normalise unicode / punctuation / whitespace
 *     -> strip filler phrases
 *     -> drop stopwords, abbreviate, stem
 *     -> emit caveman notation (bare line, or slotted block if long enough)
 *     -> restore protected spans
 *
 * The slotted form costs ~8 tokens of labels, so it is only used when the body
 * is long enough for the clarity to be worth it. Short prompts stay bare.
 */

import { protect, restore, isSentinel, subjectSpans } from './protect.js';
import { FILLER, STOPWORDS, RELATIONS, QUANTIFIERS, NEGATIONS, NEGATION_REWRITE, ABBREV } from './lexicon.js';
import { classify, defaultDeliverable } from './intent.js';
import { estimateTokens } from './tokens.js';

/**
 * How much the slotted form may cost over the bare line before it stops being
 * worth it: 25% plus a flat allowance covering the DO/WANT labels themselves.
 */
const SLOT_PREMIUM = 1.25;
const SLOT_ALLOWANCE = 6;

/** Collapse unicode decoration into plain ascii. */
function normalise(text) {
  return text
    .normalize('NFKC')
    // Emoji and pictographs.
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, ' ')
    // Smart quotes and dashes.
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/…/g, ' ')
    // Markdown decoration. Bullets become separators, not deletions.
    .replace(/^[ \t]*[-*+]\s+/gm, '; ')
    .replace(/^[ \t]*\d+[.)]\s+/gm, '; ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|~~/g, '')
    // Runs of punctuation used for emphasis.
    .replace(/([!?.,;:])\1+/g, '$1')
    .replace(/[=_-]{3,}/g, ' ')
    // Dashes left stranded by phrase removal ("Quick question - what is ...").
    .replace(/\s+-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove phrases that carry no instruction. */
function stripFiller(text) {
  let out = text;
  for (const re of FILLER) {
    // Case-insensitivity is applied here rather than per-pattern so a missing
    // `i` flag in the lexicon cannot silently disable a rule.
    const flags = re.flags.includes('i') ? re.flags : `${re.flags}i`;
    out = out.replace(new RegExp(re.source, flags), ' ');
  }
  return out.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

/** Reduce a single word. Returns '' to drop it. */
function reduceWord(word) {
  const bare = word.replace(/^[^\w'@#/.-]+|[^\w'@#/%)-]+$/g, '');
  if (!bare) return '';

  const lower = bare.toLowerCase();

  // Negations survive untouched -- dropping one inverts the request.
  if (NEGATIONS.has(lower)) {
    return NEGATION_REWRITE.get(lower) ?? lower;
  }
  if (NEGATION_REWRITE.has(lower)) {
    return NEGATION_REWRITE.get(lower);
  }
  // Relational prepositions survive untouched -- dropping one turns "delete
  // comments from files" into "delete comments files", which a tool-using
  // model can misread as the more drastic instruction.
  if (RELATIONS.has(lower)) return lower;
  // Quantifiers survive untouched -- dropping one changes how much of the
  // target the instruction covers, which word order cannot make up for.
  if (QUANTIFIERS.has(lower)) return lower;
  if (STOPWORDS.has(lower)) return '';
  if (ABBREV.has(lower)) return ABBREV.get(lower);

  // Deliberately no suffix stemming.
  //
  // It looked like free savings and is neither. Truncation produces non-words
  // ("condition" -> "condit", "validation" -> "validat"), and in testing Claude
  // read one as a truncated message and said so. It does not even reliably save
  // tokens: a BPE vocabulary encodes a common whole word like "running" as a
  // single token, while the clipped "runn" falls off the vocabulary and splits
  // into two. Character count is not token count. ABBREV covers the shortenings
  // that genuinely pay off, because those are real words the model already knows.
  return lower;
}

/** Drop stopwords, abbreviate, and stem across the whole masked body. */
function reduce(text) {
  const out = [];
  let lastWasSeparator = true;

  for (const token of text.split(/\s+/)) {
    if (!token) continue;

    if (isSentinel(token)) {
      out.push(token);
      lastWasSeparator = false;
      // A sentinel can carry sentence punctuation ("src/fetch.js?"), which
      // still ends a clause. Without this, the following text merges into the
      // same clause and constraint hoisting cannot split them apart.
      if (/[;,.!?]$/.test(token)) {
        out.push(';');
        lastWasSeparator = true;
      }
      continue;
    }

    // Preserve clause boundaries -- they group ideas for the model.
    if (/^[;,.!?]+$/.test(token)) {
      if (!lastWasSeparator && out.length) {
        out.push(';');
        lastWasSeparator = true;
      }
      continue;
    }

    const trailing = /[;,.!?]$/.test(token);
    const reduced = reduceWord(token);

    if (reduced) {
      out.push(reduced);
      lastWasSeparator = false;
    }
    if (trailing && !lastWasSeparator && out.length) {
      out.push(';');
      lastWasSeparator = true;
    }
  }

  // Trim dangling separators and collapse repeats.
  return out
    .join(' ')
    .replace(/(?:\s*;\s*)+/g, ' ; ')
    .replace(/^\s*;\s*|\s*;\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deduplicate repeated words while preserving order. */
function dedupe(text) {
  const seen = new Set();
  const out = [];
  for (const token of text.split(' ')) {
    if (token === ';') {
      out.push(token);
      continue;
    }
    const key = token.toLowerCase();
    // Only dedupe plain words; sentinels may legitimately repeat as subjects.
    if (!isSentinel(token) && seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out.join(' ').replace(/(?:\s*;\s*)+/g, ' ; ').replace(/^\s*;\s*|\s*;\s*$/g, '').trim();
}

/**
 * Compress a raw prompt into caveman notation.
 *
 * @param {string} raw
 * @param {{ slots?: boolean|'auto', dedupe?: boolean }} [options]
 * @returns {{ prompt: string, body: string, intent: object, subjects: string[],
 *             before: number, after: number, saved: number, ratio: number }}
 */
export function compress(raw, options = {}) {
  const { slots = 'auto', dedupe: shouldDedupe = true } = options;

  const { masked, spans } = protect(raw);
  const cleaned = stripFiller(normalise(masked));

  // Classify against the de-filtered text, not the raw prompt: "I have no idea
  // why" would otherwise be lifted into REQ as a binding "NO idea why".
  const intent = classify(restore(cleaned, spans));

  let body = reduce(cleaned);
  if (shouldDedupe) body = dedupe(body);

  const subjects = subjectSpans(spans);

  // Render both forms and measure, rather than guessing from a length
  // threshold. The two goals pull against each other here: slots state the
  // action, constraints, and deliverable explicitly, which is the whole point of
  // the rewrite, but the labels cost real tokens.
  //
  // So slots are allowed a small premium over the bare line and no more. Cheap
  // structure is worth buying; expensive structure is not, and on a short prompt
  // the labels can outweigh everything the compressor just saved.
  const before = estimateTokens(raw);
  const bare = renderBare(body, intent, spans);

  let prompt;
  if (slots === false) {
    prompt = bare;
  } else if (slots === true) {
    prompt = renderSlots(body, intent, subjects, spans);
  } else {
    const slotted = renderSlots(body, intent, subjects, spans);
    // Two ceilings: the premium over the bare line, and the original prompt
    // itself. On a very short prompt the flat allowance alone would let the
    // labels outgrow what the user actually typed.
    const budget = Math.min(estimateTokens(bare) * SLOT_PREMIUM + SLOT_ALLOWANCE, before);
    prompt = estimateTokens(slotted) <= budget ? slotted : bare;
  }

  // The reduce pass turns clause-ending punctuation into "; " separators, so
  // a question mark never survives to here. Put one back on questions --
  // without it, "will this break existing callers" reads as an assertion
  // instead of what it is, a yes/no question.
  if (intent.isQuestion && !/[?]\s*$/.test(prompt)) prompt = `${prompt}?`;

  const after = estimateTokens(prompt);

  return {
    prompt,
    body: restore(body, spans),
    intent,
    subjects,
    before,
    after,
    saved: Math.max(0, before - after),
    ratio: before > 0 ? Math.max(0, 1 - after / before) : 0,
  };
}

/** Short prompts: one line, action prefix only. */
function renderBare(body, intent, spans) {
  // Skip the prefix when the body already carries the verb -- "FIX fix login
  // bug" is longer than the raw prompt it replaced.
  const verb = intent.action.toLowerCase();
  const redundant = intent.action === 'DO' ||
    new RegExp(`\\b${verb.slice(0, 3)}`, 'i').test(body);
  const prefix = redundant ? '' : `${intent.action} `;
  return restore(`${prefix}${body}`, spans).trim();
}

/**
 * Drop clauses from the body that a REQ line already states.
 *
 * Clause-level rather than word-level: removing individual words would leave
 * shredded fragments, whereas a clause that is mostly constraint text is
 * wholly redundant once hoisted.
 */
function dropCovered(body, constraints) {
  if (!constraints.length) return body;

  const constraintWords = new Set(
    constraints.flatMap((c) => c.text.split(' ')).filter((w) => w && w !== ';'),
  );

  const kept = body.split(';').filter((clause) => {
    const words = clause.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    const covered = words.filter((w) => constraintWords.has(w)).length;
    return covered / words.length < 0.6;
  });

  return kept.join(' ; ').replace(/\s+/g, ' ').replace(/^\s*;\s*|\s*;\s*$/g, '').trim();
}

/** Long prompts: explicit slots so nothing has to be inferred. */
function renderSlots(body, intent, subjects, spans) {
  // 'DO' is the fallback when no verb was recognised; emitting "DO DO" would
  // spend tokens saying nothing.
  const lines = intent.action === 'DO' ? [] : [`DO ${intent.action}`];

  if (subjects.length) {
    lines.push(`RE ${subjects.slice(0, 6).join(' ')}`);
  }

  // Constraints get compressed too -- they are prose lifted from the raw prompt.
  const constraints = intent.constraints.map((c) => ({
    kind: c.kind,
    text: reduce(stripFiller(normalise(c.text))),
  })).filter((c) => c.text);

  // A constraint stated in REQ must not also be paid for in CTX.
  const context = dropCovered(body, constraints);
  if (context) lines.push(`CTX ${restore(context, spans)}`);

  if (constraints.length) {
    const parts = constraints.map((c) => `${c.kind} ${c.text}`);
    lines.push(`REQ ${restore(parts.join(' ; '), spans)}`);
  }

  // Union, not either/or: a coincidental keyword elsewhere in a long, messy
  // prompt (e.g. "why" showing up in an aside) must not silently evict the
  // action's own implied deliverable -- a FIX request that also happens to
  // ask "why" still wants the patch, not an explanation instead of one.
  const want = [...new Set([...defaultDeliverable(intent.action), ...intent.deliverables])].slice(0, 3);
  if (want.length) {
    lines.push(`WANT ${want.join(' + ')}`);
  }

  return lines.join('\n');
}
