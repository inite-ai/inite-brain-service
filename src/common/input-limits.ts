/**
 * Service-side hard caps on user-supplied free-form text. DTO-level
 * `@MaxLength` already rejects oversize payloads at the controller, but
 * not every code path reaches the service via a class-validated DTO —
 * the admin-demo controller still accepts plain inline body shapes, the
 * MCP entry point hands the service a raw arg object, and the scenario
 * runner forwards fixture strings. Calling `clampLlmInputText` at every
 * LLM-call entry point keeps the OpenAI-spend ceiling independent of
 * how the text arrived.
 *
 * Numbers match `IngestMentionDto.text`, `SearchDto.query`,
 * `IngestFactDto.object`. Bump in one place if a future model changes
 * the safe range.
 */

export const LLM_INPUT_LIMITS = {
  // Mention / extractor input — paragraph-sized doc.
  mentionText: 16_000,
  // Search / synthesize / multi-hop query — one user utterance.
  query: 8_000,
  // Single fact value.
  factObject: 2_000,
  // Predicate names, language codes, model names.
  shortIdentifier: 256,
} as const;

export type LlmInputKind = keyof typeof LLM_INPUT_LIMITS;

/**
 * Trims, then hard-truncates to the configured ceiling. Returns the
 * clamped string and a `truncated` flag so the caller can record a
 * metric / log line if it cares; most callers can just take the
 * string.
 *
 * UTF-16 length is the comparison (matches class-validator's @MaxLength
 * semantics). At these sizes the difference vs. codepoint length is
 * irrelevant for the safety goal.
 */
export function clampLlmInputText(
  value: string,
  kind: LlmInputKind,
): { value: string; truncated: boolean } {
  const limit = LLM_INPUT_LIMITS[kind];
  const trimmed = value.trim();
  if (trimmed.length <= limit) return { value: trimmed, truncated: false };
  return { value: trimmed.slice(0, limit), truncated: true };
}
