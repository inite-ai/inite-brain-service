/**
 * Media/biometric PII tier — the fail-closed gate for media evidence rows
 * (Brain v2.1 consent tier).
 *
 * POLARITY FLIP vs the text gate. Text predicates carry a single
 * `piiClass` where absence means "nothing sensitive here": the row fence
 * is `AND piiClass IS NONE` (see src/search/internals/segment-leg.ts /
 * insight-leg.ts) — an UNCLASSIFIED text row is open. Media evidence
 * inverts that: a photo or audio clip that nobody has classified may
 * contain faces, voices, or ID documents, so absence of classification
 * must mean CLOSED. Media rows therefore carry
 * `piiClasses: option<array<string>>` with three distinct states:
 *
 *   - NONE / absent  → unclassified            → BLOCKED (fail closed)
 *   - `[]`           → affirmatively clean     → open
 *   - non-empty      → classified sensitive    → blocked without scope
 *
 * The only value that opens a row to an unscoped caller is the EMPTY
 * ARRAY — an affirmative "a classifier looked and found nothing". The
 * `brain:read_media` scope (env-key-only, stricter than brain:read_pii —
 * see src/auth/api-key.types.ts) opens all three states.
 *
 * Canonical vocabulary note: this union is THE source of truth for media
 * PII classes. The evidence substrate's migrations (evidence_asset /
 * evidence_fragment, in-flight sibling PR) pin their ASSERT vocabulary to
 * these values; if they drift at rebase time, this file wins. A unit test
 * (test/media-consent.unit-spec.ts) pins the two against each other once
 * the migration exists.
 */

export type MediaPiiClass = 'face' | 'voice' | 'biometric' | 'id_document' | 'sensitive';

/** Runtime mirror of the MediaPiiClass union — for ASSERT-vocabulary pins
 *  and classifiers that enumerate the classes. */
export const MEDIA_PII_CLASSES: readonly MediaPiiClass[] = [
  'face',
  'voice',
  'biometric',
  'id_document',
  'sensitive',
];

/**
 * Row-fence SQL fragment for media evidence tables. Returns `''` when the
 * caller holds `brain:read_media` (no fence — the scope sees every state,
 * including unclassified), else ` AND <field> = []` — which in
 * SurrealQL is true ONLY for the affirmatively-clean empty array:
 * NONE/absent (unclassified) and non-empty (classified) rows both fail
 * the equality, so absence stays closed. Interpolate after a WHERE that
 * already pins tenant/user scope, mirroring the text `piiGate` call sites.
 *
 * `field` (default `piiClasses`, the direct-table read) lets a caller
 * fence through a record-link path — e.g. the fragment lane reads
 * derived_representation rows and fences on the parent fragment's
 * column via `subjectId.piiClasses`. Static call-site strings only,
 * never caller input.
 */
export function mediaPiiGate(callerScopes: readonly string[], field = 'piiClasses'): string {
  return callerScopes.includes('brain:read_media') ? '' : ` AND ${field} = []`;
}

/**
 * JS-side twin of {@link mediaPiiGate} for per-item decisions (rows
 * already in hand, e.g. the raw-evidence per-call gate in
 * src/mcp/raw-evidence-gate.ts). Same polarity table:
 * scope → allowed; `[]` → allowed; NONE/undefined or non-empty → denied.
 */
export function mediaPiiAllowed(
  piiClasses: readonly string[] | null | undefined,
  callerScopes: readonly string[],
): boolean {
  if (callerScopes.includes('brain:read_media')) return true;
  return Array.isArray(piiClasses) && piiClasses.length === 0;
}

/**
 * STRICTEST union of two media piiClasses states — the raw-read
 * gateway's fragment twins serve whole parent-asset bytes, so BOTH the
 * fragment's and the asset's classification constrain the serve. Same
 * polarity table as above: an unclassified (NONE/absent) side wins
 * (undefined out — blocked); otherwise the set union — `[]` only when
 * BOTH sides are affirmatively clean.
 */
export function strictestPiiUnion(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): readonly string[] | undefined {
  if (!Array.isArray(a) || !Array.isArray(b)) return undefined;
  return [...new Set([...a, ...b])];
}
