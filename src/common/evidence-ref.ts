/**
 * EvidenceRef — the ONE typed pointer shape for "what grounds this claim"
 * across the evidence plane (Brain v2.1 M1). Pure module (episode-ids.ts
 * discipline): importable from composers, outcome writers, and the
 * provenance walker alike, no I/O, no Nest.
 *
 * THE "evidence" NAMING MAP (see the 0109 migration header for the long
 * form):
 *   * `source.evidence[]` (SourceEvidence, ingest-fact DTO) —
 *     caller-asserted EXTERNAL provenance, untouched by this module; the
 *     'external' arm below carries its `kind` vocabulary.
 *   * memory_outcome.subjectKind = 'evidence' (0107) — binds to
 *     evidence_asset ids ONLY; a fragment outcome rolls up to its parent
 *     asset (see outcomeSubjectFor).
 *   * "evidence plane" docs branding — the episode/segment grounding
 *     surface; the 'episode' arm is that plane, the asset/fragment arms
 *     EXTEND it beyond text.
 */
import type { SourceEvidence } from '../ingest/dto/ingest-fact.dto';

/** The `source.evidence[].kind` vocabulary (type-level, from the DTO). */
export type SourceEvidenceKind = SourceEvidence['kind'];

/**
 * Runtime copy of the kind vocabulary, pinned two ways: `satisfies`
 * rejects a stray member at compile time, and the exhaustiveness check
 * below fails to compile if the DTO union gains a kind this list lacks.
 * (EVIDENCE_KINDS in ingest-utils.ts:100-108 is the unexported runtime
 * Set on the ingest path; the unit spec pins behavioral sync through
 * evidenceValidationError.)
 */
export const SOURCE_EVIDENCE_KINDS = [
  'event',
  'message',
  'conversation',
  'url',
  'document',
  'commit',
  'other',
] as const satisfies readonly SourceEvidenceKind[];

// Compile-time exhaustiveness: a DTO kind missing from the array makes
// this Exclude non-never and the assignment below stop compiling.
type MissingKinds = Exclude<SourceEvidenceKind, (typeof SOURCE_EVIDENCE_KINDS)[number]>;
const _sourceEvidenceKindsExhaustive: MissingKinds extends never ? true : never = true;
void _sourceEvidenceKindsExhaustive;

export type EvidenceRef =
  | { kind: 'episode'; episodeId: string; span?: { start: number; end: number; exact: string } }
  | { kind: 'fragment'; fragmentId: string; assetId?: string }
  | { kind: 'asset'; assetId: string }
  | { kind: 'external'; sourceKind: SourceEvidenceKind; ref: string; note?: string };

/**
 * Dispatch a raw record-id string on its table prefix into a typed ref.
 * Only the three record-backed arms are parseable — an 'external' ref has
 * no record id by definition. Anything else (other tables, bare tails,
 * non-strings coerced upstream) → null, never a guess.
 */
export function parseRecordRef(raw: string): EvidenceRef | null {
  if (raw.startsWith('episode:')) return { kind: 'episode', episodeId: raw };
  if (raw.startsWith('evidence_fragment:')) return { kind: 'fragment', fragmentId: raw };
  if (raw.startsWith('evidence_asset:')) return { kind: 'asset', assetId: raw };
  return null;
}

/**
 * The outcome-telemetry binding rule (0107 × 0109): which
 * memory_outcome subject a ref's outcome events attach to.
 *   * asset    → subjectKind 'evidence', subjectId = the asset id;
 *   * fragment → ROLLS UP to its parent asset — needs `assetId` on the
 *     ref (null without it: better no telemetry than a fragment-keyed
 *     subject that would split the per-observation signal);
 *   * episode  → subjectKind 'episode';
 *   * external → null (nothing brain-owned to key on).
 */
export function outcomeSubjectFor(
  ref: EvidenceRef,
): { subjectKind: 'evidence' | 'episode'; subjectId: string } | null {
  switch (ref.kind) {
    case 'asset':
      return { subjectKind: 'evidence', subjectId: ref.assetId };
    case 'fragment':
      return ref.assetId ? { subjectKind: 'evidence', subjectId: ref.assetId } : null;
    case 'episode':
      return { subjectKind: 'episode', subjectId: ref.episodeId };
    case 'external':
      return null;
  }
}

/**
 * Union of members' evidence record-id lists — the unionEpisodeIds
 * (episode-ids.ts) idiom widened to the three evidence-plane prefixes:
 * each value String()-coerced and filtered to a known record prefix
 * (lists are FLEXIBLE-sourced — shapes are never guaranteed), deduped
 * with member order preserved (Set insertion order), capped at 64.
 */
export function unionEvidenceRefs(memberRefLists: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const list of memberRefLists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const id = String(raw);
      if (parseRecordRef(id) !== null) out.add(id);
    }
  }
  return [...out].slice(0, 64);
}
