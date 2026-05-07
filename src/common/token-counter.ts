import { encodingForModel, getEncoding, type Tiktoken } from 'js-tiktoken';

/**
 * Token counter shared across services for response budget enforcement.
 *
 * Uses js-tiktoken (pure-JS port of OpenAI's tiktoken) so we get the
 * same sub-word tokenisation OpenAI's models bill against. The earlier
 * `chars / 4` heuristic was off by ±15% on average and ±50% on
 * structured JSON (lots of `{},":` punctuation tokenises differently
 * than prose).
 *
 * The encoder is loaded once per process — `cl100k_base` covers
 * gpt-4o, gpt-4-turbo, gpt-3.5-turbo, text-embedding-3-*, so a single
 * encoder serves every Claude/OpenAI model brain currently calls or
 * estimates against.
 */
let cached: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (cached) return cached;
  // Try model-specific first; fall back to the family encoding.
  try {
    cached = encodingForModel('gpt-4o-mini');
  } catch {
    cached = getEncoding('cl100k_base');
  }
  return cached;
}

/**
 * Count tokens in a string. Returns an exact tiktoken count, not an
 * approximation. ~10 µs per call for typical fact-sized strings;
 * the encoder is cached so first-call cost is paid once per process.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Count tokens for an arbitrary value, JSON-encoded. Used for
 * response-shape budget enforcement (search KnowQL `tokenBudget`).
 * Tokenises the serialised form because that's what an agent will
 * actually consume from the API response.
 */
export function countJsonTokens(value: unknown): number {
  return countTokens(JSON.stringify(value));
}
