/**
 * The caveman lexicon.
 *
 * Three tiers of removal, in increasing risk:
 *   1. FILLER    -- phrases that carry no instruction at all. Always safe.
 *   2. STOPWORDS -- grammatical glue. Safe because the model reconstructs it.
 *   3. ABBREV    -- shortenings the model already knows from real-world code.
 *
 * NEGATIONS is the counterweight: these words invert meaning and must never be
 * dropped, no matter which tier would otherwise catch them.
 */

/** Phrases removed wholesale. Applied before tokenisation, case-insensitive. */
export const FILLER = [
  // Requests wrapped in politeness.
  /\bi\s+(?:was\s+)?wonder(?:ing)?\s+if\s+(?:you\s+)?(?:could|can|would|might)\b/g,
  /\b(?:could|can|would|will)\s+you\s+(?:please\s+)?(?:help\s+me\s+)?(?:to\s+)?/g,
  /\bplease\s+(?:could|can|would)\s+you\b/g,
  /\bi\s+(?:would\s+like|'d\s+like|want|need)\s+(?:you\s+)?to\b/g,
  /\bi\s+(?:am|'m)\s+trying\s+to\b/g,
  /\bwhat\s+i\s+(?:want|need|would like)\s+is\b/g,
  /\bis\s+(?:it|there)\s+(?:a\s+way|possible)\s+(?:to|for)\b/g,
  // The optional adverb slot matters: "would be *really* great if" is the
  // common form, and without it the whole phrase survives.
  /\bit\s+would\s+be\s+(?:\w+\s+)?(?:great|nice|awesome|helpful|good|cool)\s+if\b/g,
  /\bif\s+you\s+could\s+(?:just\s+)?(?:take\s+a\s+look|have\s+a\s+look|check)\b/g,
  /\btake\s+a\s+look\s+at\b/g,
  /\bdo\s+you\s+think\s+you\s+(?:could|can)\b/g,
  /\bhelp\s+me\s+(?:out\s+)?(?:with|to)\b/g,
  /\bhelp\s+me\b(?=\s+\w)/g,

  // Bare politeness markers.
  /\bplease\b/g,
  /\bkindly\b/g,

  // Gratitude and sign-off. Ordered longest-first so "thanks so much in
  // advance" is consumed whole rather than leaving "in advance" behind.
  /\bthanks?\b(?:\s+(?:a\s+lot|so\s+much|very\s+much|again))?(?:\s+in\s+advance)?/g,
  /\bthank\s+you\b(?:\s+(?:so\s+much|very\s+much))?(?:\s+in\s+advance)?/g,
  /\bin\s+advance\b/g,
  /\b(?:much\s+)?appreciated?\b/g,
  /\bcheers\b/g,
  /\bsorry\s+(?:to\s+bother|for\s+the|about\s+the|if)\b[^.!?\n]*/g,
  /\blet\s+me\s+know\s+(?:if|what|when|how)\b[^.!?\n]*/g,
  /\bfeel\s+free\s+to\b/g,
  /\bany\s+help\s+(?:would\s+be\s+)?(?:appreciated|great|welcome)\b/g,
  /\bhope\s+(?:that\s+)?(?:this|it|you)\b[^.!?\n]*/g,

  // Meta-commentary about the question itself.
  /\b(?:just\s+a\s+)?quick\s+question\b/g,
  /\bi\s+have\s+a\s+question\s+(?:about|on|regarding)\b/g,
  /\bif\s+(?:it(?:'s|\s+is)\s+)?possible\b/g,
  /\bif\s+you\s+(?:get|have)\s+(?:a|the)\s+(?:chance|time|moment)\b/g,
  /\bwhen\s+you\s+(?:get|have)\s+(?:a|the)\s+(?:chance|time|moment)\b/g,
  /\bas\s+soon\s+as\s+possible\b/g,
  /\bfor\s+(?:me|us)\b/g,

  // Hedges and epistemic padding.
  /\bi\s+(?:think|believe|guess|assume|suppose|reckon)\s+(?:that\s+)?/g,
  /\bi\s+feel\s+like\b/g,
  /\bin\s+my\s+(?:opinion|experience|view)\b/g,
  /\bit\s+(?:seems|appears)\s+(?:like|that|to\s+be)?\b/g,
  /\b(?:kind|sort)\s+of\b/g,
  /\ba\s+(?:bit|little)\b/g,
  /\byou\s+know\b/g,
  /\bi\s+mean\b/g,
  /\bor\s+something(?:\s+like\s+that)?\b/g,
  /\betc\.?\b/g,
  /\band\s+so\s+on\b/g,

  // Greetings, usually the entire first clause.
  /^\s*(?:hey|hi|hello|yo|good\s+(?:morning|afternoon|evening))\b[^,.!?\n]*[,.!]?/gi,
  /\bhey\s+there\b[!,.]?/g,

  // Single-word intensifiers and discourse markers.
  /\b(?:basically|essential|essentially|actual|actually|literally|obvious|obviously|simply|really|very|quite|just|super|pretty\s+much|somewhat|rather|totally|definitely|certainly|absolutely|honestly|frankly|indeed|possibly|maybe|perhaps|somehow|annoying|weird|strange|well)\b/g,
  /\bi\s+have\s+no\s+(?:idea|clue)\b[^.!?\n]*/g,
  /\bfor\s+some\s+reason\b/g,
  /\bway\s+too\b/g,
  /\b(?:so|anyway|anyways|okay|ok|alright|right|now|hey|hi|hello|yeah|yep)\s*,\s*/g,
  /\bcurrently\b/g,
  /\bat\s+the\s+moment\b/g,
  /\bgoing\s+forward\b/g,
];

/**
 * Grammatical glue. Dropped after filler removal.
 * Deliberately excludes: negations, coordinators (and/or/but), comparatives,
 * question words, and relational prepositions -- all of which carry instruction.
 */
export const STOPWORDS = new Set([
  // Articles.
  'a', 'an', 'the',
  // Copulas and auxiliaries.
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'having',
  'will', 'shall', 'would',
  // Pronouns. ("you"/"i" are noise once the request is an imperative.)
  'i', 'me', 'my', 'mine', 'myself',
  'we', 'us', 'our', 'ours',
  'you', 'your', 'yours',
  'it', 'its', 'they', 'them', 'their', 'theirs',
  'he', 'him', 'his', 'she', 'her', 'hers',
  // Determiners and demonstratives.
  'that', 'those', 'these', 'there', 'here',
  // Prepositions that the model reconstructs from word order.
  'of', 'at', 'by', 'as', 'than', 'then',
  'about', 'for',
  // Relativisers and complementisers.
  'which', 'whose', 'whom', 'who',
  // 'if' is deliberately absent: it marks real conditional instructions
  // ("if the tests fail, revert"), and dropping it inverts the request.
  'and', 'also', 'too', 'both', 'so', 'though', 'however',
  // Misc.
  'thing', 'things', 'stuff', 'something', 'anything', 'one',
]);

/**
 * Prepositions that state which of two nouns is the target and which is the
 * container/source -- "delete comments FROM files" vs "delete comments files".
 * Word order alone does not carry that relation the way it does for most
 * prepositions, so dropping these turns a scoped instruction into a bag of
 * nouns a tool-using model can misresolve as the more drastic reading (e.g.
 * "delete files"). Checked before STOPWORDS, same tier as NEGATIONS.
 */
export const RELATIONS = new Set([
  'from', 'into', 'onto', 'upon', 'in', 'on', 'off', 'out', 'over', 'within', 'inside',
  // "to" states which of two names/values/paths is the target: "rename A to
  // B", "move X to Y", "change 3 to 5" -- lose it and the direction of the
  // edit (and which name survives) is a coin flip.
  'to', 'with',
  // Phrasal-verb particles. "up"/"down" are not spatial words here, they are
  // half of the verb: "back up the database" losing "up" reads as "back db"
  // -- not a degraded backup instruction, a missing one. Same failure for
  // "shut down", "clean up", "roll back" (already safe: "back" isn't a
  // stopword), "give up", "scale down".
  'up', 'down',
]);

/**
 * Quantifiers. These state scope -- how much of the target the instruction
 * covers -- and word order does not reconstruct that the way it does for
 * ordinary determiners. "remove some of the console.log statements" losing
 * "some" reads as "remove [all of] the console.log statements": a scoped,
 * careful request compresses into what looks like a blanket one. "every"/
 * "each" losing their word can just as easily invert the other way, reading
 * as a single item instead of all of them ("check every test file" ->
 * "check test file"). Never dropped, same tier as RELATIONS.
 */
export const QUANTIFIERS = new Set(['some', 'any', 'each', 'every', 'either']);

/**
 * Words that invert or restrict meaning. Never removed, never abbreviated.
 * Checked before every removal pass.
 */
export const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'neither', 'nor', 'without',
  'except', 'unless', 'but', 'only', 'instead', 'rather',
  'dont', "don't", 'doesnt', "doesn't", 'didnt', "didn't",
  'cant', "can't", 'cannot', 'wont', "won't", 'shouldnt', "shouldn't",
  'isnt', "isn't", 'arent', "aren't", 'wasnt', "wasn't",
  'avoid', 'skip', 'ignore', 'exclude', 'stop', 'prevent',
]);

/** Contractions normalised to a single negation token. */
export const NEGATION_REWRITE = new Map([
  ["don't", 'no'], ['dont', 'no'],
  ["doesn't", 'no'], ['doesnt', 'no'],
  ["didn't", 'no'], ['didnt', 'no'],
  ["can't", 'no'], ['cant', 'no'], ['cannot', 'no'],
  ["won't", 'no'], ['wont', 'no'],
  ["shouldn't", 'no'], ['shouldnt', 'no'],
  ["isn't", 'no'], ['isnt', 'no'],
  ["aren't", 'no'], ['arent', 'no'],
  ["wasn't", 'no'], ['wasnt', 'no'],
  ["it's", ''], ['thats', ''], ["that's", ''],
  ["i'm", ''], ["i've", ''], ["you're", ''], ["we're", ''],
]);

/**
 * Shortenings. Every one of these is standard in real codebases, so the model
 * decodes them without being told.
 */
export const ABBREV = new Map(Object.entries({
  application: 'app',
  applications: 'apps',
  argument: 'arg',
  arguments: 'args',
  authentication: 'auth',
  authorization: 'authz',
  because: 'bc',
  button: 'btn',
  calculate: 'calc',
  command: 'cmd',
  commands: 'cmds',
  configuration: 'config',
  configure: 'config',
  database: 'db',
  dependencies: 'deps',
  dependency: 'dep',
  development: 'dev',
  directory: 'dir',
  directories: 'dirs',
  documentation: 'docs',
  document: 'doc',
  environment: 'env',
  error: 'err',
  errors: 'errs',
  example: 'eg',
  function: 'fn',
  functions: 'fns',
  implement: 'add',
  implementation: 'impl',
  information: 'info',
  initialize: 'init',
  javascript: 'js',
  kubernetes: 'k8s',
  library: 'lib',
  maximum: 'max',
  message: 'msg',
  messages: 'msgs',
  minimum: 'min',
  number: 'num',
  optimize: 'opt',
  optimise: 'opt',
  package: 'pkg',
  parameter: 'param',
  parameters: 'params',
  performance: 'perf',
  previous: 'prev',
  production: 'prod',
  property: 'prop',
  properties: 'props',
  python: 'py',
  reference: 'ref',
  repository: 'repo',
  request: 'req',
  requests: 'reqs',
  response: 'res',
  responses: 'res',
  specification: 'spec',
  statement: 'stmt',
  temporary: 'tmp',
  typescript: 'ts',
  validate: 'valid',
  variable: 'var',
  variables: 'vars',
  version: 'ver',
}));

// There is intentionally no suffix-stemming table here; see reduceWord() in
// compress.js for why truncating words costs meaning without saving tokens.
