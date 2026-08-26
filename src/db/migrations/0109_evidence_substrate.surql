-- 0109: evidence substrate — the multimodal Evidence Plane storage
-- primitives (Brain v2.1 M1).
--
-- WHY. Memory today is text-first: the RAW plane (episode turns, 0073),
-- the SEMANTIC plane (knowledge_fact), the EPISODIC plane (memory_episode
-- scenes, 0106). Observations that arrive as images, audio, video,
-- documents-as-bytes, or sensor captures have NO first-class identity —
-- at best a caption string is ingested and the original observation is
-- lost. This migration adds three tables that give non-text observations
-- durable identity WITHOUT ever putting bytes in the database:
--   * evidence_asset          — the ORIGINAL observation's metadata
--     (modality, hash, dimensions, where the bytes live). One row per
--     distinct original byte stream.
--   * evidence_fragment       — the universal CITATION TARGET: a located
--     region of an asset (a time range, a page region, a frame span, a
--     char range). Answers cite fragments the way they cite episodes.
--   * derived_representation  — a RECOMPUTABLE interpretation of an asset
--     or fragment (caption, ocr, asr, object track, scene graph,
--     embedding, text render), versioned by producer so re-runs replace
--     by version, never mutate in place.
-- The doctrine carried over from 0048 ("Brain must not know what a PDF
-- is") extends naturally: a caption is an INDEX into an observation,
-- never a REPLACEMENT for it. Bytes NEVER live in the DB — storageRef is
-- an adapter-scheme URI ('fs://…') resolved by the storage-adapter
-- registry, and originUri points at a caller-owned external location.
--
-- THE "evidence" NAMING MAP (three prior uses, none of which this
-- migration changes):
--   * source.evidence[] (ingest-fact DTO / ingest-utils EVIDENCE_KINDS) —
--     caller-asserted EXTERNAL provenance pointers stored verbatim inside
--     knowledge_fact.source. Untouched; an evidence_asset is
--     brain-registered, content-addressed, and lifecycle-managed, which
--     source.evidence[] never was.
--   * memory_outcome.subjectKind = 'evidence' (0107) — outcome telemetry
--     binds to evidence_asset ids ONLY: a fragment-level outcome rolls up
--     to its parent asset (the ranking currency is per-observation, and a
--     per-fragment rollup would fragment the signal). See
--     outcomeSubjectFor() in src/common/evidence-ref.ts.
--   * "evidence plane" in the Brain v2 docs branding — the episode +
--     segment grounding surface. These tables EXTEND that plane beyond
--     text; they do not rename or replace it.
--
-- ALTERNATIVES CONSIDERED.
--   * Reusing source_document (0048): rejected — source_document stores
--     NORMALIZED REDACTED TEXT and its contentHash is the hash of that
--     text; an asset's byteHash is the sha256 of the ORIGINAL bytes,
--     which the brain never parses. Conflating the two identities would
--     make "same text, different scan" and "same bytes, different
--     redactor version" indistinguishable.
--   * Bytes in the DB (SurrealDB bytes type): rejected — blob lifecycle
--     (retention, GDPR, tiering) must not ride the row lifecycle, and
--     multi-GB video in a rocksdb value is an operational trap. The
--     adapter contract keeps blob storage swappable (fs now; s3-class
--     later) without touching rows.
--   * A typed record<...> subjectId on derived_representation: rejected —
--     a representation targets an asset OR a fragment; the untyped
--     `record` + subjectKind discriminator is the memory_outcome (0107)
--     precedent and keeps GDPR traversal uniform.
--
-- NO CHANGEFEED on any of the three tables, deliberately (same GDPR
-- reasoning as 0073/0106/0107): fragments carry human-written labels and
-- representations carry caption/ocr/asr text derived from personal
-- observations — a 30-day INCLUDE ORIGINAL feed would keep GDPR-erased
-- content readable after the rows die. Rebuild scheduling for derived
-- representations is producerVersion + re-run, not a feed.
--
-- RENUMBER CAVEAT: 0108 is claimed by the in-flight GDPR-cascade PR
-- (forgotten_entity doc counters). If that PR has not merged when this
-- lands, the migrator orders by filename and tolerates gaps — 0109 stays
-- 0109 either way; do NOT renumber on rebase.

-- ── evidence_asset ────────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS evidence_asset SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS modality ON evidence_asset TYPE string
  ASSERT $value INSIDE ['image', 'audio', 'video', 'document', 'sensor'];
-- IANA media type ('image/jpeg', 'application/pdf'…). Open string — new
-- media types must not need a migration (0048 `kind` precedent); the
-- shape is code-validated at the write seam (evidence-store.service.ts).
DEFINE FIELD IF NOT EXISTS mediaType ON evidence_asset TYPE string;
-- sha256 hex of the ORIGINAL bytes — NOT the 0048 contentHash, which
-- hashes the normalized REDACTED text of a parsed document. An asset's
-- identity is the byte stream the brain never parses; the same photo
-- re-registered dedupes here regardless of any downstream OCR/redaction.
DEFINE FIELD IF NOT EXISTS byteHash ON evidence_asset TYPE string;
DEFINE FIELD IF NOT EXISTS byteLength ON evidence_asset TYPE int;
DEFINE FIELD IF NOT EXISTS width ON evidence_asset TYPE option<int>;
DEFINE FIELD IF NOT EXISTS height ON evidence_asset TYPE option<int>;
DEFINE FIELD IF NOT EXISTS durationMs ON evidence_asset TYPE option<int>;
DEFINE FIELD IF NOT EXISTS pageCount ON evidence_asset TYPE option<int>;
-- When the observation HAPPENED (0048 occurredAt doctrine: the photo's
-- capture time, the recording's start) vs when the brain recorded it.
DEFINE FIELD IF NOT EXISTS occurredAt ON evidence_asset TYPE datetime;
DEFINE FIELD IF NOT EXISTS recordedAt ON evidence_asset TYPE datetime DEFAULT time::now();
-- Adapter-scheme URI ('fs://<companyId>/<byteHash>') resolved by the
-- storage-adapter registry — never a raw filesystem path.
DEFINE FIELD IF NOT EXISTS storageRef ON evidence_asset TYPE option<string>;
-- Caller-owned pointer back to where the bytes live externally (0048
-- originUri doctrine) — the brain never fetches it.
DEFINE FIELD IF NOT EXISTS originUri ON evidence_asset TYPE option<string>;
-- 'hot' = adapter-managed blob present; 'cold' = adapter-managed but
-- offline tier (reserved); 'external' = originUri only; 'gone' = bytes
-- deleted, header survives as tombstone (0048 'purged' precedent).
DEFINE FIELD IF NOT EXISTS availability ON evidence_asset TYPE string DEFAULT 'external'
  ASSERT $value INSIDE ['hot', 'cold', 'external', 'gone'];
-- Per-user scope (0055 model) + scope tags (0093), like memory_episode.
DEFINE FIELD IF NOT EXISTS userId ON evidence_asset TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope ON evidence_asset TYPE array<string> DEFAULT [];
-- PII classes present in the OBSERVATION itself. NONE = unclassified →
-- FAIL-CLOSED: future read gates open only on an affirmatively-clean []
-- or the media scope; the class vocabulary is owned by the consent tier
-- (sibling PR) — this ASSERT pins the storage shape, not the policy.
DEFINE FIELD IF NOT EXISTS piiClasses ON evidence_asset TYPE option<array<string>>
  ASSERT $value IS NONE OR $value ALLINSIDE ['face', 'voice', 'biometric', 'id_document', 'sensitive'];
DEFINE FIELD IF NOT EXISTS vertical ON evidence_asset TYPE string;
-- Who delivered the observation (0048 recorder doctrine).
DEFINE FIELD IF NOT EXISTS recorder ON evidence_asset TYPE option<string>;
DEFINE FIELD IF NOT EXISTS retainUntil ON evidence_asset TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS meta ON evidence_asset TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS createdAt ON evidence_asset TYPE datetime DEFAULT time::now();
-- Drive-by (0101 idiom): the sweep-reindexable gist vector on
-- memory_episode had no space column — defined below with the other
-- 0101 stragglers; assets themselves carry no vector in v1.

-- ALL single-field indexes, deliberately: on SurrealDB 3.2.4 a DELETE
-- whose WHERE is planned through a COMPOUND index can silently no-op
-- (the preSweepOutcomeRows / scene-membership bug class), and these
-- tables sit on TWO delete paths (GDPR cascade + retention sweep).
-- byteHash UNIQUE is also the 1:1 row↔blob invariant: one row per byte
-- stream means deleting a row's blob can never orphan another row's.
DEFINE INDEX IF NOT EXISTS evidence_asset_hash_idx ON evidence_asset FIELDS byteHash UNIQUE;
DEFINE INDEX IF NOT EXISTS evidence_asset_user_idx ON evidence_asset FIELDS userId;
DEFINE INDEX IF NOT EXISTS evidence_asset_avail_idx ON evidence_asset FIELDS availability;
DEFINE INDEX IF NOT EXISTS evidence_asset_retain_idx ON evidence_asset FIELDS retainUntil;

-- ── evidence_fragment ─────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS evidence_fragment SCHEMAFULL;

-- Typed record link — the GDPR user-forget cascade traverses
-- assetId.userId, so the target table must be known to the schema.
DEFINE FIELD IF NOT EXISTS assetId ON evidence_fragment TYPE record<evidence_asset>;
-- Kind-discriminated locator (charRange / pageRegion / timeRange /
-- frameRange / track), FLEXIBLE because the shape union is code-owned:
-- validateLocator() in src/evidence/locator.ts cross-checks kind against
-- the parent asset's modality at the write seam.
DEFINE FIELD IF NOT EXISTS locator ON evidence_fragment TYPE object FLEXIBLE;
-- Human label, ≤200 code-capped and passed through redactPiiWithReport
-- at write (the 0106 sceneLabel discipline).
DEFINE FIELD IF NOT EXISTS label ON evidence_fragment TYPE option<string>;
-- Same shape + fail-closed contract as evidence_asset.piiClasses.
DEFINE FIELD IF NOT EXISTS piiClasses ON evidence_fragment TYPE option<array<string>>
  ASSERT $value IS NONE OR $value ALLINSIDE ['face', 'voice', 'biometric', 'id_document', 'sensitive'];
DEFINE FIELD IF NOT EXISTS createdAt ON evidence_fragment TYPE datetime DEFAULT time::now();

-- Single-field only. NO UNIQUE (assetId, locator) pair index, despite the
-- natural-key temptation: a compound index would put assetId under the
-- 3.2.4 compound-planner DELETE no-op (this table is on both delete
-- paths), and locator is a FLEXIBLE object — dedup belongs to the write
-- seam, not the planner's key comparison.
DEFINE INDEX IF NOT EXISTS evidence_fragment_asset_idx ON evidence_fragment FIELDS assetId;

-- ── derived_representation ────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS derived_representation SCHEMAFULL;

-- Untyped record: the subject is an evidence_asset OR an
-- evidence_fragment (memory_outcome.subjectId precedent, 0107) —
-- discriminated by subjectKind, still traversable in the GDPR cascade.
DEFINE FIELD IF NOT EXISTS subjectId ON derived_representation TYPE record;
DEFINE FIELD IF NOT EXISTS subjectKind ON derived_representation TYPE string
  ASSERT $value INSIDE ['asset', 'fragment'];
DEFINE FIELD IF NOT EXISTS kind ON derived_representation TYPE string
  ASSERT $value INSIDE ['caption', 'ocr', 'asr', 'object_track', 'scene_graph', 'embedding', 'text'];
DEFINE FIELD IF NOT EXISTS content ON derived_representation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS model ON derived_representation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS modelVersion ON derived_representation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS promptVersion ON derived_representation TYPE option<string>;
-- 0101 idiom: which embedding space a stored vector lives in.
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON derived_representation TYPE option<string>
  ASSERT $value IS NONE OR string::len($value) >= 3;
-- WRITE-DEAD in v1: no producer fills this yet — the multi-vector design
-- (per-representation spaces, cross-modal retrieval) is a design doc
-- away, and the column existing now means no second migration then.
DEFINE FIELD IF NOT EXISTS embedding ON derived_representation TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS confidence ON derived_representation TYPE option<float>
  ASSERT $value IS NONE OR ($value >= 0 AND $value <= 1);
DEFINE FIELD IF NOT EXISTS lang ON derived_representation TYPE option<string>;
-- segmenterVersion analogue (0106): a producer re-run deletes its own
-- version's rows then reinserts — representations are recomputable
-- derived state, never mutated in place.
DEFINE FIELD IF NOT EXISTS producerVersion ON derived_representation TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON derived_representation TYPE datetime DEFAULT time::now();

-- Single-field only (same 3.2.4 planner rationale as above).
DEFINE INDEX IF NOT EXISTS derived_repr_subject_idx ON derived_representation FIELDS subjectId;
DEFINE INDEX IF NOT EXISTS derived_repr_kind_idx ON derived_representation FIELDS kind;
DEFINE INDEX IF NOT EXISTS derived_repr_ver_idx ON derived_representation FIELDS producerVersion;

-- ── drive-by: memory_episode joins the 0101 space-tracking family ─────
-- EMBEDDING_TABLES gains memory_episode.gistEmbedding in this PR (0106
-- landed after 0101, so the reindex sweep silently skipped scene
-- vectors); the sweep stamps embeddingSpaceId on rewrite when tracking
-- is on, and SCHEMAFULL would reject the stamp without this column.
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON memory_episode TYPE option<string>
  ASSERT $value IS NONE OR string::len($value) >= 3;

-- ── GDPR tombstone counters (0080/0106 idiom) ─────────────────────────
-- Stamped by whichever forget path owns a tombstone row when it erases
-- evidence rows. NOTE: the ENTITY forget does NOT delete assets — an
-- asset is a user/tenant-scoped observation, not an entity-scoped claim;
-- erasing a subject entity removes what the brain BELIEVES about it, not
-- what a tenant OBSERVED (which may ground other subjects). Assets die
-- with their user (user-forget cascade) or their tenant (offboarding).
DEFINE FIELD IF NOT EXISTS evidenceAssetsDeleted ON forgotten_entity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS evidenceFragmentsDeleted ON forgotten_entity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS representationsDeleted ON forgotten_entity TYPE option<int>;
