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
  ['FIX', /\b(?:fix(?:ed|es|ing)?|repair|debug|broken|breaks|breaking|fail(?:s|ed|ing)?|crash(?:es|ed|ing)?|bug|regression|not\s+work\w*|doesn'?t\s+work|won'?t\s+work|throw(?:s|n|ing)?|exception|stack\s?trace|traceback|reject(?:s|ed|ing)?|hang(?:s|ing)?|does(?:n'?t)?\s+(?:do\s+anything|respond|load)|nothing\s+happens|no\s+response|unresponsive|not\s+responding)\b/i],
  ['TEST', /\b(?:test|tests|testing|unit\s?test|spec|specs|coverage|jest|pytest|vitest|mocha|assertion)\b/i],
  ['REFACTOR', /\b(?:refactor|clean\s?up|cleanup|tidy|simplify|restructure|reorganis|reorganiz|rewrite|extract|dedupe|deduplicate|split\s+up)\b/i],
  ['OPTIMIZE', /\b(?:optimi[sz]e|faster|speed\s?up|slow|performance|perf|bottleneck|memory\s+leak|latency|n\+1)\b/i],
  ['EXPLAIN', /\b(?:explain|what\s+(?:is|are|does|do)|why\s+(?:is|are|does|do|did)|how\s+(?:does|do|is|are)|understand|walk\s+me\s+through|describe|clarify|difference\s+between|meaning\s+of)\b/i],
  ['REVIEW', /\b(?:review|audit|critique|check\s+(?:if|whether|my|the)|look\s+over|sanity\s?check|code\s?review|is\s+(?:this|it|that)\s+(?:\w+[\s-]){0,3}?(?:correct|right|good|safe|secure|efficient|idiomatic|acceptable|ok(?:ay)?))\b/i],
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

/**
 * A subject pronoun/noun sitting immediately before "don't"/"never" etc. means
 * the sentence's grammatical subject is *them* ("I dont get why", "it doesnt
 * work", "people dont click"), not an implied "you" -- i.e. the user
 * describing behavior, not instructing Claude. Genuine imperatives ("don't
 * break the API") have no such subject immediately before the trigger.
 */
const NOT_IMPERATIVE_SUBJECT = '(?<!\\b(?:i|we|you|he|she|they|it|this|that|people|users?|someone|something)\\s)';

/**
 * Constraints worth restating verbatim -- they change what a correct answer is.
 * Bare "no" is split from the other NO triggers (don't/never/avoid/without) and
 * flagged `symptomGuard: true`: those other words are unambiguously imperative,
 * but bare "no" is just as often descriptive ("no error, no response") as
 * prohibitive ("no side effects"), and misreading the former as a rule to
 * follow turns a bug report into nonsense instructions.
 */
const CONSTRAINT_PATTERNS = [
  [new RegExp(`${NOT_IMPERATIVE_SUBJECT}\\b(?:don'?t|do\\s+not|never|avoid|without)\\s+([a-z][\\w\\s-]{2,60}?)(?=[,.;!?\\n]|$)`, 'gi'), 'NO'],
  [new RegExp(`${NOT_IMPERATIVE_SUBJECT}\\bno\\s+([a-z][\\w\\s-]{2,60}?)(?=[,.;!?\\n]|$)`, 'gi'), 'NO', { symptomGuard: true }],
  [/\b(?:must|has\s+to|have\s+to|needs?\s+to|required\s+to|make\s+sure\s+(?:to|that|you))\s+([a-z][\w\s-]{2,60}?)(?=[,.;!?\n]|$)/gi, 'MUST'],
  [/\bonly\s+([a-z][\w\s-]{2,60}?)(?=[,.;!?\n]|$)/gi, 'ONLY'],
  [/\b(?:keep|preserve|retain|maintain)\s+([a-z][\w\s-]{2,60}?)(?=[,.;!?\n]|$)/gi, 'KEEP'],
  [/\b(?:using|use|with)\s+([A-Za-z][\w.-]{1,20}(?:\s+\d+(?:\.\d+)*)?)\s*(?:$|[,.])/gi, 'USE'],
];

/** Constraint bodies that name nothing actionable. */
const VAGUE = /^(?:something|anything|nothing|it|this|that|them|things?|stuff|sure|the\s+\w{1,3})$/i;

/**
 * A constraint body that talks about the *speaker's own* state of mind is the
 * user narrating their confusion ("no duplicate email so I dont get why its
 * saying that"), not handing Claude a rule to follow. Reusing SYMPTOM_RE
 * catches the other shape of false positive: a bare "no" restating a symptom
 * word already captured by hasSymptom ("no error no nothing").
 */
const NARRATION_RE = /\bi\s+(?:dont|don'?t|didn'?t|already|get|think|know|see|noticed|checked|found|guess)\b/i;

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
  const isQuestion = /\?/.test(text) ||
    /^\s*(?:what|why|how|when|where|which|who|is|are|does|do|can|should|could|will|would)\b/i.test(text);

  // A reported symptom with no explicit verb is a bug report, not an open
  // question: "the endpoint returns null" means fix it.
  if (action === 'DO' && hasSymptom) action = 'FIX';
  // Anything else still unclassified but phrased as a question ("is this
  // thread safe?", "will this break callers?") is asking for an answer, not
  // an edit -- without this, it renders as a bare, ambiguous-looking
  // declarative fragment with no verb and no question mark.
  else if (action === 'DO' && isQuestion) action = 'EXPLAIN';

  const deliverables = [];
  for (const [name, re] of DELIVERABLES) {
    if (re.test(text)) deliverables.push(name);
  }

  const constraints = [];
  const seen = new Set();
  for (const [re, kind, opts] of CONSTRAINT_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const body = match[1].trim().replace(/\s+/g, ' ');
      const key = `${kind}:${body.toLowerCase()}`;
      if (seen.has(key) || body.length < 3) continue;
      // A constraint that names nothing concrete is noise the model must still
      // read and reconcile, so it costs more than it carries.
      if (VAGUE.test(body)) continue;
      // The user talking about their own confusion, not issuing a rule.
      if (NARRATION_RE.test(body)) continue;
      // Bare "no" is ambiguous between prohibitive ("no side effects") and
      // descriptive ("no error, no response"); when the body itself reads as
      // a symptom, it's the latter and must not become a REQ line.
      if (opts?.symptomGuard && SYMPTOM_RE.test(body)) continue;
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
    isQuestion,
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
