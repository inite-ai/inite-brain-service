/**
 * The two populations that share `source_document.meta`, and the seam
 * that keeps them apart.
 *
 * `IngestDocumentDto.meta` is the CALLER channel: operator vocabulary
 * (`data_class: pii`, `department: finance`) that the commit writer
 * projects onto every derived fact's `source.meta`, where ABAC source
 * rules match it. Untrusted input into a security-relevant surface, so
 * it is sanitized (snake_case keys, short scalars, ≤16 entries) and,
 * under SOURCE_META_STRICT, rejected outright rather than silently
 * trimmed — a dropped `data_class` would silently widen access.
 *
 * Brain also writes provenance of its OWN onto the same column: the
 * mention wrapper's contextRef identifiers, the 0111 tool-observation
 * hop. Those are not caller input and never reach `source.meta` —
 * `CommitWriterService.factSource` re-sanitizes `doc.meta` before
 * projecting, so camelCase brain keys are filtered there by design and
 * are read back only off the RAW document header. Running them through
 * the caller's gate on the way IN is therefore a category error: it
 * validates brain's vocabulary against a rule written for somebody
 * else's, and under SOURCE_META_STRICT it 400s the write.
 *
 * This module is that boundary. Internal writers hand their bag to
 * `mergeDocumentMeta` as `internal`, which is typed to the declared
 * brain-owned keys (so the channel cannot become a back door for
 * arbitrary unvalidated meta) and never sees the caller gate. The same
 * keys are stripped from the caller's bag on the way through, so a
 * client cannot forge brain provenance — notably `toolObservationRef`,
 * which the commit writer folds into `source.evidence[]` verbatim.
 */

/** Keys the pipeline synthesises for itself. Callers may not assert them. */
export const INTERNAL_DOCUMENT_META_KEYS = [
  // Mention-via-document: the typed MentionContextRef identifiers.
  'conversationId',
  'messageId',
  'eventId',
  // 0111 tool-observation provenance hop (DocumentIngestService).
  'toolObservationRef',
  'toolObservationNote',
] as const;

export type InternalDocumentMetaKey = (typeof INTERNAL_DOCUMENT_META_KEYS)[number];

/** A brain-synthesised document-header bag: declared keys, string values. */
export type InternalDocumentMeta = Partial<Record<InternalDocumentMetaKey, string>>;

const RESERVED = new Set<string>(INTERNAL_DOCUMENT_META_KEYS);

/**
 * Build an internal bag, dropping absent entries. A JS object literal
 * materialises a key even when its value is `undefined`, which is how
 * the mention wrapper came to assert `eventId` on requests that never
 * sent one — so the omission has to be explicit, here, once.
 */
export function internalDocumentMeta(
  entries: Partial<Record<InternalDocumentMetaKey, string | undefined>>,
): InternalDocumentMeta | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as InternalDocumentMeta) : undefined;
}

/**
 * Reserved keys a caller's bag tried to assert. Stripping them is not
 * negotiable, but it must not be silent — dropping caller data without
 * saying so is the exact failure mode SOURCE_META_STRICT exists to
 * prevent, so the store warns on a non-empty result. (Under the strict
 * flag this list is unreachable today: every reserved key is camelCase
 * and the sanitizer 400s it first.)
 */
export function reservedKeysIn(callerMeta: Record<string, unknown> | undefined): string[] {
  if (callerMeta === undefined) return [];
  return Object.keys(callerMeta).filter((key) => RESERVED.has(key));
}

/**
 * The stored `meta` column: the caller's bag (verbatim — sanitization
 * is the caller gate's job and happens before this, at the store) minus
 * any reserved key it tried to assert, with brain's own provenance
 * overlaid on top.
 *
 * Absent on both sides ⇒ `undefined`, so a metadata-free document keeps
 * the pre-fix row byte-identical.
 */
export function mergeDocumentMeta(
  callerMeta: Record<string, unknown> | undefined,
  internal: InternalDocumentMeta | undefined,
): Record<string, unknown> | undefined {
  if (callerMeta === undefined && internal === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(callerMeta ?? {})) {
    if (!RESERVED.has(key)) out[key] = value;
  }
  return Object.assign(out, internal ?? {});
}
