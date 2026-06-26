/**
 * Pure helpers extracted from IngestService (and de-duplicated against
 * IngestPredictorService, which carried its own copy of sourceTrustFor).
 *
 * Everything here is deterministic and I/O-free — record-id slicing, the
 * dot-safe externalRef key, the naive PII redactor, the source-trust
 * heuristic, and the HyPE write-gate predicate — so the rules are
 * unit-testable without a live SurrealDB or an LLM.
 */
import { SOURCE_TRUST } from './conflict-resolver';

/** Strip the `table:` prefix off a SurrealDB record id, leaving the tail. */
export function idTailOf(rid: string): string {
  const i = rid.indexOf(':');
  return i === -1 ? rid : rid.slice(i + 1);
}

/**
 * Build a SurrealDB-safe externalRefs key. SurrealQL CONTENT treats dots
 * inside object keys as nested-path separators, so a key like
 * "rent.cust_42" silently expands into nested fields and is then dropped
 * by the schemafull `externalRefs: object` constraint. Replace dots with
 * a double underscore — the original `vertical.entityId` form is
 * recoverable but stored unambiguously as a single property.
 */
export function externalRefKey(vertical: string, id: string): string {
  const safe = (s: string) => s.replace(/\./g, '__');
  return `${safe(vertical)}__${safe(id)}`;
}

/**
 * Naive PII redactor — masks emails, phone-like numbers, and 9+ digit runs.
 * 0.2.0 will replace this with @inite/assistant.piiMask once the package
 * exposes a server-side import path.
 */
export function redactPii(text: string): string {
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[PHONE]')
    .replace(/\b\d{9,}\b/g, '[NUM]');
}

/**
 * Heuristic source-trust label derived from the source's shape. Billing /
 * incidents / auth events are most trusted, inbox extractions less so,
 * everything else falls to the default. Shared by the ingest write path
 * and the ingest predictor so the two never drift.
 */
export function sourceTrustFor(source: {
  vertical: string;
  eventId?: string;
  messageId?: string;
  recorder?: string;
}): number {
  if (source.eventId?.startsWith('billing.')) return SOURCE_TRUST.billing_event;
  if (source.eventId?.startsWith('incidents.'))
    return SOURCE_TRUST.incidents_event;
  if (source.eventId?.startsWith('auth.')) return SOURCE_TRUST.auth_event;
  if (source.messageId) return SOURCE_TRUST.inbox_extraction;
  return SOURCE_TRUST.default;
}

/**
 * Gate for the HyPE post-INSERT alt-embedding UPDATE. We only generate +
 * write the hypothetical-question embedding when a fact was actually
 * INSERTED (not superseded/competed/rejected), HyPE is enabled, and we
 * have a concrete factId to UPDATE — otherwise we'd burn an LLM call on a
 * row that won't keep the embedding.
 */
export function shouldWriteHypeAltEmbedding(
  outcome: unknown,
  hypeEnabled: boolean,
  factId: string | null,
): boolean {
  return factId !== null && hypeEnabled && outcome === 'INSERTED';
}
