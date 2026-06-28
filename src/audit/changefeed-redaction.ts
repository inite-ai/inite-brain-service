/**
 * Redact PII *value* fields from a changefeed post-image before it is
 * mirrored into audit_event. The mirror is a structural change-log: it
 * records WHICH predicate changed on WHICH entity (id, predicate,
 * status, validity, op) — it must NOT carry the raw sensitive VALUE
 * (a fact `object` like an email/address, or an entity name/aliases).
 *
 * This is also the structural defence for the GDPR forget race: a
 * record whose CREATE/UPDATE is still unconsumed when the subject is
 * forgotten gets re-materialised here AFTER the forget purge — but with
 * the value already redacted, so no raw PII re-appears in audit_event.
 * `embedding` is dropped as bloat (huge float array, not human PII).
 */
export const REDACTED = '[redacted]';

// Allowlist of STRUCTURAL fields kept verbatim in the audit mirror. Any
// other field — present or future — is redacted, so a new PII-bearing
// column can't silently leak (denylist regressed once: canonicalNameLc /
// externalRefs were missed). `embedding` is dropped as bloat.
const STRUCTURAL_FIELDS = new Set([
  'id',
  'entityId',
  'predicate',
  'op',
  'status',
  'validFrom',
  'validUntil',
  'recordedAt',
  'retractedAt',
  'retractionReason',
  'supersededBy',
  'priorValidUntil',
  'confidence',
  'kind',
  'in',
  'out',
  'weight',
  'artifactType',
  'dirty',
  'mergedInto',
  'mergedAt',
  'type',
]);

export function redactAfterImage(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'embedding') continue; // drop float-array bloat
    out[k] = STRUCTURAL_FIELDS.has(k) || v == null ? v : REDACTED;
  }
  return out;
}
