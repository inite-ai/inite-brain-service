import { envFlagEnabled } from './env-validation';

/**
 * Pack memory projections master flag — PACK_MEMORY_PROJECTIONS_ENABLED
 * (migration 0110).
 *
 * When on, external candidate submissions (POST /v1/documents/:id/
 * candidates) may carry `scenes` / `stateDeltas` arrays — validated
 * against the submitting pack's OWN manifest memoryModel declarations
 * (sceneSchemas / stateModels) — staged as candidate kinds
 * 'scene'/'state_delta', and projected at commit time into shadow
 * memory_episode rows under the namespaced segmenterVersion
 * `pack:<packId>+<fp>` (SceneCandidateWriterService; disjoint by
 * construction from the composer's `scene-segmenter-v1*` id-spaces).
 *
 * The env read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable (no
 * restart). Default off ⇒ submissions carrying either array are rejected
 * 400, no 'scene'/'state_delta' candidate row is ever written, and no
 * memory_episode projection ever runs — byte-identical prod (shadow even
 * when on: nothing on the serving path reads memory_episode). PACK_ sits
 * off the ENGINE flag budget (a shadow-substrate writer, not an engine
 * fork — the SCENES_ family precedent).
 *
 * The GDPR forget document-cascade leg for projected rows runs REGARDLESS
 * of this flag: rows written while on must stay erasable after a flip off
 * (the env-validation design rule).
 */
export function packMemoryProjectionsEnabled(): boolean {
  return envFlagEnabled(process.env.PACK_MEMORY_PROJECTIONS_ENABLED);
}

/**
 * Source-version stamps + drift staleness master flag —
 * PACK_SOURCE_VERSION_STALENESS.
 *
 * When on, an external candidate submission may carry a `sourceVersion`
 * stamp ({system, ref, version, readAt} — src/common/source-version.ts)
 * naming the revision of the external system of record the claims were
 * derived from. The stamp rides the candidate provenance into every
 * committed fact's `source.sourceVersion`, and the same submission
 * sweeps the pack's DERIVABLE facts whose stamp is behind that version,
 * marking them with the EXISTING staleness fields (staleAt/staleReason,
 * migration 0072) as candidates for re-verification.
 *
 * Which predicates are derivable is DECLARED, never hardcoded: the
 * pack's manifest `memoryModel.verificationRules` carry
 * `{ requires: 'source_version_match', appliesTo: [...localIds] }`. An
 * interpretation (decided/because/gotcha/invariant) is a statement about
 * the past and does not rot when new commits land, so it is simply not
 * listed and is never swept.
 *
 * The env read lives here in the common layer, NOT inside the engine
 * dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ a submitted `sourceVersion` is rejected
 * 400, no candidate payload or fact source ever gains the key, and no
 * sweep query runs — byte-identical prod. PACK_ sits off the ENGINE flag
 * budget (a pack-declared perception contract, the
 * PACK_MEMORY_PROJECTIONS_ENABLED precedent).
 */
export function packSourceVersionStalenessEnabled(): boolean {
  return envFlagEnabled(process.env.PACK_SOURCE_VERSION_STALENESS);
}
