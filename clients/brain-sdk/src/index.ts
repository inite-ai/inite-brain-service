/**
 * @inite/brain — the TypeScript SDK.
 *
 * Three layers, each usable without the others:
 *
 *   createBrain       the typed client: remember, recall, answer, history
 *   brainTools        the same, shaped as framework tools (AI SDK and
 *                     anything else that takes { description, inputSchema,
 *                     execute })
 *   createBrainStore  a LangGraph-shaped store over brain's memory files
 *
 * zod is the only dependency, because a zod schema plus an async function
 * is the common denominator of every JS agent framework worth adapting
 * to — so one object serves all of them and none of them has to be
 * installed to use this package.
 */
export { Brain, BrainError, createBrain } from './client.js';
export type {
  AnswerResult,
  BrainOptions,
  RecallFact,
  RecallHit,
  RememberResult,
  TimelineEvent,
} from './client.js';
export { brainTools } from './tools.js';
export type { BrainTool } from './tools.js';
export { BrainStore, createBrainStore } from './store.js';
export type { StoreItem } from './store.js';
