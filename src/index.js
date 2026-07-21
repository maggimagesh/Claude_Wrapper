/**
 * Programmatic entry point, for using the compressor without the CLI.
 *
 *   import { compress, ask } from 'claudecode-wrapper';
 *   const { prompt } = compress('could you please fix the login bug?');
 *   const { text } = await ask(prompt);
 */

export { compress } from './compress.js';
export { ask, buildArgs, inputTokens, PROTOCOL } from './claude.js';
export { classify } from './intent.js';
export { estimateTokens, reduction } from './tokens.js';
export { protect, restore } from './protect.js';
