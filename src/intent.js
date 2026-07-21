/**
 * Intent extraction.
 *
 * Compression alone shortens a prompt. It does not make it *clearer*. This pass
 * handles the other half of the job: deciding what the user is actually asking
 * for, so the compressed prompt can state it outright instead of leaving the
 * model to infer it from a pile of stripped keywords.
 */

/** Action verbs, checked against the raw prompt in priority order. */
const ACTIONS = [
  ['FIX', /\b(?:fix(?:ed|es|ing)?|repair|debug|broken|breaks|breaking|fail(?:s|ed|ing)?|crash(?:es|ed|ing)?|bug|regression|not\s+work\w*|doesn'?t\s+work|won'?t\s+work|throw(?:s|n|ing)?|exception|stack\s?trace|traceback|reject(?:s|ed|ing)?|hang(?:s|ing)?)\b/i],
  ['TEST', /\b(?:test|tests|testing|unit\s?test|spec|specs|coverage|jest|pytest|vitest|mocha|assertion)\b/i],
  ['REFACTOR', /\b(?:refactor|clean\s?up|cleanup|tidy|simplify|restructure|reorganis|reorganiz|rewrite|extract|dedupe|deduplicate|split\s+up)\b/i],
  ['OPTIMIZE', /\b(?:optimi[sz]e|faster|speed\s?up|slow|performance|perf|bottleneck|memory\s+leak|latency|n\+1)\b/i],
  ['EXPLAIN', /\b(?:explain|what\s+(?:is|are|does|do)|why\s+(?:is|are|does|do|did)|how\s+(?:does|do|is|are)|understand|walk\s+me\s+through|describe|clarify|difference\s+between|meaning\s+of)\b/i],
  ['REVIEW', /\b(?:review|audit|critique|check\s+(?:if|whether|my|the)|look\s+over|sanity\s?check|code\s?review|is\s+this\s+(?:correct|right|good|safe))\b/i],
  ['FIND', /\b(?:find|where\s+(?:is|are|does|do)|locate|search\s+for|which\s+file|grep|look\s+for|track\s+down)\b/i],
  ['DELETE', /\b(?:delete|remove|drop|get\s+rid\s+of|purge|uninstall|revert)\b/i],
  ['UPDATE', /\b(?:update|upgrade|bump|migrate|port|convert|rename|replace|change|modify|switch\s+to)\b/i],
  ['DOC', /\b(?:document|docs|readme|docstring|comment(?:s|ing)?|changelog|jsdoc)\b/i],
  ['PLAN', /\b(?:plan|design|architect|approach|strategy|how\s+should\s+(?:i|we)|best\s+way\s+to|trade[- ]?offs?)\b/i],
  ['ADVISE', /\b(?:should\s+(?:i|we)|recommend|suggest|which\s+(?:is\s+better|should)|worth\s+it|pros\s+and\s+cons|better\s+to)\b/i],
  ['ADD', /\b(?:add|create|make|build|implement|write|generate|scaffold|set\s?up|introduce|support\s+for|new\s+)\b/i],
];

/** What the user wants back. Drives response shape. */
const DELIVERABLES = [
  ['patch', /\b(?:patch|diff|fix\s+it|apply|edit|change\s+the\s+(?:code|file)|make\s+the\s+change)\b/i],
  ['code', /\b(?:code|snippet|function|implementation|write\s+(?:me\s+)?(?:a|the)|show\s+me\s+(?:a|the|how))\b/i],
  ['steps', /\b(?:steps|step\s+by\s+step|instructions|guide|walkthrough|checklist)\b/i],
  ['list', /\b(?:list|enumerate|all\s+the|which\s+ones|options)\b/i],
  ['reason', /\b(?:why|reason|cause|root\s+cause|because|rationale|explain\s+why)\b/i],
  ['plan', /\b(?:plan|outline|design\s+doc|proposal)\b/i],
];

/** Constraints worth restating verbatim -- they change what a correct answer is. */
const CONSTRAINT_PATTERNS = [
  [/\b(?:don'?t|do\s+not|never|avoid|without|no)\s+([a-z][\w\s-]{2,60}?)(?=[,.;!?\n]|$)/gi, 'NO'],
  [/\b(?:must|has\s+to|have\s+to|needs?\s+to|required\s+to|make\s+sure\s+(?:to|that|you))\s+([a-z][\w\s-]{2,60}?)(?=[,.;!?\n]|$)/gi, 'MUST'],
  [/\bonly\s+([a-z][\w\s-]{2,60}?)(?=[,.;!?\n]|$)/gi, 'ONLY'],
  [/\b(?:keep|preserve|retain|maintain)\s+([a-z][\w\s-]{2,60}?)(?=[,.;!?\n]|$)/gi, 'KEEP'],
  [/\b(?:using|use|with)\s+([A-Za-z][\w.-]{1,20}(?:\s+\d+(?:\.\d+)*)?)\s*(?:$|[,.])/gi, 'USE'],
];

/** Constraint bodies that name nothing actionable. */
const VAGUE = /^(?:something|anything|nothing|it|this|that|them|things?|stuff|sure|the\s+\w{1,3})$/i;

/** Signals that the user is reporting a symptom rather than requesting a build. */
const SYMPTOM_RE = /\b(?:error|exception|fails?|failing|crash(?:es|ed)?|hangs?|times?\s+out|returns?\s+(?:null|undefined|nothing|empty)|500|404|502|undefined|null\s+pointer|segfault|stack\s?overflow)\b/i;

/**
 * Classify a raw prompt.
 * @param {string} raw
 * @returns {{action: string, deliverables: string[], constraints: {kind: string, text: string}[], hasSymptom: boolean, isQuestion: boolean}}
 */
export function classify(raw) {
  const text = raw.trim();

  let action = 'DO';
  for (const [name, re] of ACTIONS) {
    if (re.test(text)) {
      action = name;
      break;
    }
  }

  const hasSymptom = SYMPTOM_RE.test(text);

  // A reported symptom with no explicit verb is a bug report, not an open
  // question: "the endpoint returns null" means fix it.
  if (action === 'DO' && hasSymptom) action = 'FIX';

  const deliverables = [];
  for (const [name, re] of DELIVERABLES) {
    if (re.test(text)) deliverables.push(name);
  }

  const constraints = [];
  const seen = new Set();
  for (const [re, kind] of CONSTRAINT_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const body = match[1].trim().replace(/\s+/g, ' ');
      const key = `${kind}:${body.toLowerCase()}`;
      if (seen.has(key) || body.length < 3) continue;
      // A constraint that names nothing concrete is noise the model must still
      // read and reconcile, so it costs more than it carries.
      if (VAGUE.test(body)) continue;
      seen.add(key);
      constraints.push({ kind, text: body });
      if (constraints.length >= 5) break;
    }
  }

  return {
    action,
    deliverables: deliverables.slice(0, 3),
    constraints,
    hasSymptom,
    isQuestion: /\?/.test(text) || /^\s*(?:what|why|how|when|where|which|who|is|are|does|do|can|should|could)\b/i.test(text),
  };
}

/**
 * Default deliverable when the user did not say what they want back.
 * Inferred from the action so the model does not have to guess.
 */
export function defaultDeliverable(action) {
  switch (action) {
    case 'FIX': return ['patch', 'reason'];
    case 'ADD': return ['code'];
    case 'TEST': return ['code'];
    case 'REFACTOR': return ['patch'];
    case 'OPTIMIZE': return ['patch', 'reason'];
    case 'EXPLAIN': return ['reason'];
    case 'REVIEW': return ['list'];
    case 'FIND': return ['list'];
    case 'DELETE': return ['patch'];
    case 'UPDATE': return ['patch'];
    case 'DOC': return ['code'];
    case 'PLAN': return ['plan'];
    case 'ADVISE': return ['reason'];
    default: return [];
  }
}
