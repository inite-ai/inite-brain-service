-- 0113_outcome_dimensions — outcome-telemetry modality dimensions (Part 1)
-- + the per-predicate evidence-capability requirement (Part 2), Brain v2.1.
--
-- NUMBERING NOTE: 0108-0112 are claimed by in-flight sibling PRs of the
-- same wave; this migration deliberately takes 0113. The migrator applies
-- by numeric order and tracks per-id, so the gap is harmless whether the
-- siblings land before or after this one.
--
-- Part 1 — memory_outcome gains two OPTIONAL dimensions:
--   * modality           — which evidence modality the outcome concerns
--                          ('text' | 'visual' | 'audio' | 'document_region');
--   * representationKind — free-form representation tag within the modality
--                          (e.g. 'caption', 'ocr_text', 'frame_embedding').
-- NONE = legacy/text: every pre-0113 row and every text-path writer.
--
-- TOP-LEVEL COLUMNS, NOT meta KEYS — two 0107 contracts force this:
--   * meta is CONTENT-FREE by contract (record ids / verdict strings only,
--     0107 header) and is deliberately shapeless (FLEXIBLE) — a queryable
--     dimension does not belong in it;
--   * the writer's dedupe key IGNORES meta entirely
--     (memory-outcome.service.ts dedupeOutcomeEvents) — a dimension buried
--     in meta would be invisible to event partitioning, so two outcomes of
--     the same event on different modalities would collapse into one row.
--
-- memory_outcome_stat is UNTOUCHED: the rollup stays UNIQUE-per-subject.
-- Per-modality stat columns are deliberately DEFERRED — no scorer consumes
-- them yet, and the raw rows retain full dimensionality, so a per-modality
-- rollup can be introduced later without loss (it would be maintained
-- forward by the writer, like 0107 — never recomputed from pruned raw).

DEFINE FIELD IF NOT EXISTS modality ON memory_outcome TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['text', 'visual', 'audio', 'document_region'];
DEFINE FIELD IF NOT EXISTS representationKind ON memory_outcome TYPE option<string>;

-- Part 2 — verifier evidence-capability check (FOVEA_EVIDENCE_CAPABILITY):
-- the per-predicate REQUIREMENT column. A predicate whose claims can only
-- be verified against non-text evidence (a whiteboard photo, a call
-- recording, a contract region) declares it here; the finalize-time gate
-- reads it through the registry snapshot. Absent (NONE) = 'text' =
-- unconstrained — every CORE seed predicate and every pre-0113 row.
-- Open option<string> (not an ASSERT enum) on purpose: the closed union
-- lives in TS (EvidenceCapability, synthesize.types.ts) and the registry
-- row mapping drops unknown values to unconstrained — a malformed row must
-- degrade to today's behavior, never abstain-storm a tenant.
DEFINE FIELD IF NOT EXISTS requiredEvidenceCapability ON knowledge_predicate TYPE option<string>;
