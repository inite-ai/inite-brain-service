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

/** PII classes the redactor can find — stored as episode.piiClass. */
export type PiiClass = 'email' | 'phone' | 'number';

/**
 * PII redactor with a report of what it found (P0 of the substrate
 * redesign). The historical phone regex was destructive on temporal text —
 * `"2019-2023"` → `[PHONE]`, `"May 7, 1998. 2019"` mangled — because any
 * 9+-char digit/separator run matched. A candidate now masks only when its
 * DIGIT count is phone/card-shaped (9-16) and it does not look like a year
 * range or an ISO datetime. Dates, ranges, and ratings pass through intact;
 * real phones (10-15 digits) and separated card numbers (16) still mask.
 */
export function redactPiiWithReport(text: string): {
  text: string;
  classes: PiiClass[];
} {
  const classes = new Set<PiiClass>();
  const out = text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => {
      classes.add('email');
      return '[EMAIL]';
    })
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 16) return m;
      // Year range / year list ("1998. 2019", "2019 - 2023" never reach
      // here at ≤8 digits; this guards 3-year spans and similar).
      if (/^\s*(19|20)\d{2}(\D+(19|20)\d{2})+\s*$/.test(m)) return m;
      // ISO datetime ("2023-05-07 12:34") — temporal, not a phone.
      if (/^\s*(19|20)\d{2}-\d{2}-\d{2}/.test(m)) return m;
      classes.add('phone');
      return '[PHONE]';
    })
    .replace(/\b\d{9,}\b/g, () => {
      // A bare digit run ≥9 is an id/account/card; ISO-less timestamps
      // (e.g. epoch millis) are ids too — mask. Years never reach 9 digits.
      classes.add('number');
      return '[NUM]';
    });
  return { text: out, classes: [...classes] };
}

/**
 * Back-compat wrapper — every existing call site keeps its signature; the
 * fix rides in via redactPiiWithReport.
 */
export function redactPii(text: string): string {
  return redactPiiWithReport(text).text;
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

const EVIDENCE_KINDS = new Set([
  'event',
  'message',
  'conversation',
  'url',
  'document',
  'commit',
  'other',
]);
const EVIDENCE_MAX_ITEMS = 10;
const EVIDENCE_MAX_REF = 512;
const EVIDENCE_MAX_NOTE = 512;

/**
 * Shape-check for `source.evidence` (SourceEvidence[]). Returns a
 * human-readable error string, or null when valid/absent. Lives here (not
 * class-validator) because `source` is an opaque @IsObject — the global
 * whitelist pipe would strip a nested union. Caps keep the FLEXIBLE
 * source object from becoming an unbounded blob on the hot write path.
 */
export function evidenceValidationError(evidence: unknown): string | null {
  if (evidence === undefined) return null;
  if (!Array.isArray(evidence)) return 'source.evidence must be an array';
  if (evidence.length > EVIDENCE_MAX_ITEMS) {
    return `source.evidence must have at most ${EVIDENCE_MAX_ITEMS} entries`;
  }
  for (const [i, e] of evidence.entries()) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      return `source.evidence[${i}] must be an object`;
    }
    const { kind, ref, note } = e as Record<string, unknown>;
    if (typeof kind !== 'string' || !EVIDENCE_KINDS.has(kind)) {
      return `source.evidence[${i}].kind must be one of ${[...EVIDENCE_KINDS].join('|')}`;
    }
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > EVIDENCE_MAX_REF) {
      return `source.evidence[${i}].ref must be a non-empty string of at most ${EVIDENCE_MAX_REF} chars`;
    }
    if (
      note !== undefined &&
      (typeof note !== 'string' || note.length > EVIDENCE_MAX_NOTE)
    ) {
      return `source.evidence[${i}].note must be a string of at most ${EVIDENCE_MAX_NOTE} chars`;
    }
  }
  return null;
}

