-- 0106: memory_episode — the shadow Scenes substrate (Brain v2 PR1,
-- episodic-plane primitive).
--
-- WHY. Brain v2 frames memory as three planes: the RAW plane (verbatim
-- `episode` turns, 0073), the SEMANTIC plane (derived `knowledge_fact`
-- propositions), and — missing until now — the EPISODIC plane: coherent
-- multi-turn SCENES that sit between them. A scene is a versioned, derived
-- grouping of contiguous raw turns within one session (session-gap first,
-- optional topic-boundary refinement), carrying a deterministic gist, a
-- per-dimension memory-value assessment, and typed membership edges back to
-- the exact turns it covers. Facts answer "what is true"; scenes answer
-- "what happened, together, when" — the unit that summarization,
-- consolidation, and dual-trace style retrieval want and that neither raw
-- turns (too granular) nor positional `episode_segment` windows (fixed
-- stride, no semantic boundary, no value model) provide.
--
-- SHADOW. Nothing on the serving path reads these tables. The composer
-- (scene-composer.service.ts, SCENES_SEGMENTATION_ENABLED, default off)
-- writes only memory_episode / memory_episode_member / projection rows —
-- prod behavior is byte-identical with the flag off, and remains
-- serving-identical with it on. Derived state: rebuildable from `episode`
-- at any time (delete-by-conversation-and-version then reinsert), so
-- removal is DROP both tables + delete the composer — no reader to migrate.
--
-- NAMING NOTES.
--  * `residual` was REJECTED as a field name for the unexpected-details
--    payload: it is already the projection lifecycle status
--    (contracts/episodes/driver.schema.ts PROJECTION_STATUSES), and scenes
--    register in that same projection ledger — one word, two meanings in
--    one subsystem is a trap. The field is `unexpectedDetails`.
--  * memoryValue is a VECTOR of per-dimension scores (novelty,
--    contradiction, stateChange, identity, explicitness, estimatedUtility),
--    NOT a single surprise scalar: the dimensions are consumed
--    independently by consolidation policy (PR2+), and collapsing them at
--    write time would bake one weighting into stored data. Every dimension
--    is optional — the deterministic v0 scorer fills only what it can
--    compute without an LLM; the rest stays NONE until a paid scorer runs.
--
-- ALTERNATIVES CONSIDERED.
--  * Reusing episode_segment (0075): rejected — segments are positional
--    sliding windows keyed (conversationId, seq) with no boundary
--    semantics, no versioned segmenter, no value model, and a UNIQUE key
--    that cannot host overlapping scene generations side by side.
--  * A sessionId column on `episode`: rejected in 0073 (sessionization is
--    a derivation-time concern) and still rejected here — scenes are one
--    of many possible segmentations, hence versioned rows in their own
--    table, keyed by segmenterVersion so competing segmenters coexist.
--
-- NO CHANGEFEED on either table, deliberately (same GDPR reasoning as
-- 0073): scenes quote-derive from verbatim turns, and a 30-day INCLUDE
-- ORIGINAL feed would keep forgotten scene gists readable after a GDPR
-- delete. Rebuild scheduling is the admin trigger + projection registry,
-- not a feed.

DEFINE TABLE IF NOT EXISTS memory_episode SCHEMAFULL;

-- Per-user scope (0055 model) + scope tags (0093) + PII classes, folded
-- from the member turns exactly like episode_segment: userId only when the
-- whole scene is one user's; a mixed-user scene stays tenant-global.
DEFINE FIELD IF NOT EXISTS userId ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope ON memory_episode TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS piiClass ON memory_episode TYPE option<array<string>>;

-- Deterministic label (first non-assistant turn, trimmed; ≤200 enforced in
-- code — the segmenter emits ≤80 today, the cap leaves LLM labels room).
DEFINE FIELD IF NOT EXISTS sceneLabel ON memory_episode TYPE string;
DEFINE FIELD IF NOT EXISTS conversationIds ON memory_episode TYPE array<string>;
DEFINE FIELD IF NOT EXISTS occurredFrom ON memory_episode TYPE datetime;
DEFINE FIELD IF NOT EXISTS occurredTo ON memory_episode TYPE datetime;
DEFINE FIELD IF NOT EXISTS recordedAt ON memory_episode TYPE datetime DEFAULT time::now();

-- Canonical gist TEXT (deterministic render in v1; PII-safe by
-- construction — member turns are already redacted at capture).
DEFINE FIELD IF NOT EXISTS gist ON memory_episode TYPE string;
DEFINE FIELD IF NOT EXISTS gistEmbedding ON memory_episode TYPE option<array<float>>;

-- Semantic backlinks into the knowledge graph (PR2 fills these).
DEFINE FIELD IF NOT EXISTS entityIds ON memory_episode TYPE option<array<record<knowledge_entity>>>;
DEFINE FIELD IF NOT EXISTS relationIds ON memory_episode TYPE option<array<record<knowledge_edge>>>;

-- Per-dimension memory value (see NAMING NOTES above — a vector, not a
-- surprise scalar). Every dimension optional; the scorer stamps its own
-- version + time so mixed-scorer worlds stay auditable.
DEFINE FIELD IF NOT EXISTS memoryValue ON memory_episode TYPE option<object>;
DEFINE FIELD IF NOT EXISTS memoryValue.novelty ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS memoryValue.contradiction ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS memoryValue.stateChange ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS memoryValue.identity ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS memoryValue.explicitness ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS memoryValue.estimatedUtility ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS memoryValue.scorerVersion ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS memoryValue.scoredAt ON memory_episode TYPE option<datetime>;

DEFINE FIELD IF NOT EXISTS confidence ON memory_episode TYPE float
  ASSERT $value >= 0 AND $value <= 1;

-- Surprise payload (NOT `residual` — see NAMING NOTES).
DEFINE FIELD IF NOT EXISTS unexpectedDetails ON memory_episode TYPE option<array<string>>;

-- State-delta capture for the world-model plane (PR3+); FLEXIBLE because
-- the delta shape is scorer-owned, not schema-owned yet.
DEFINE FIELD IF NOT EXISTS stateDeltas ON memory_episode TYPE option<array<object>> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS baselineRef ON memory_episode TYPE option<object> FLEXIBLE;

-- Versioning: competing segmenters coexist keyed by segmenterVersion; one
-- generation stamp per rebuild run (0081 idiom) makes partial runs visible.
DEFINE FIELD IF NOT EXISTS segmenterVersion ON memory_episode TYPE string;
DEFINE FIELD IF NOT EXISTS encoderVersion ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS gistPromptVersion ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS generation ON memory_episode TYPE string;
DEFINE FIELD IF NOT EXISTS source ON memory_episode TYPE object FLEXIBLE;

-- Consolidation trail (PR2+): facts distilled out of this scene.
DEFINE FIELD IF NOT EXISTS consolidatedInto ON memory_episode TYPE option<array<record<knowledge_fact>>>;

DEFINE INDEX IF NOT EXISTS scene_version_idx ON memory_episode FIELDS segmenterVersion;
DEFINE INDEX IF NOT EXISTS scene_conv_idx ON memory_episode FIELDS conversationIds;
DEFINE INDEX IF NOT EXISTS scene_user_idx ON memory_episode FIELDS userId;
DEFINE INDEX IF NOT EXISTS scene_time_idx ON memory_episode FIELDS occurredFrom;

-- Same lowercase-only analyzer contract as episode_text (0073) /
-- segment_text (0075): snowball stemming would mangle non-Latin scripts,
-- and scene gists quote multilingual verbatim dialogue.
DEFINE ANALYZER IF NOT EXISTS scene_gist TOKENIZERS class FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS scene_gist_search ON memory_episode
  FIELDS gist FULLTEXT ANALYZER scene_gist BM25;

-- Typed membership: scene -> member turn. A RELATION table so graph
-- tooling sees it, but QUERIES MUST NOT use graph-arrow syntax (plain
-- `WHERE in/out` reads only) — the composer and both GDPR cascades filter
-- on in/out as ordinary record fields, so a plain SCHEMAFULL table with
-- explicit in/out record fields would behave identically.
DEFINE TABLE IF NOT EXISTS memory_episode_member
  SCHEMAFULL TYPE RELATION FROM memory_episode TO episode;

DEFINE FIELD IF NOT EXISTS role ON memory_episode_member TYPE string
  ASSERT $value INSIDE ['core', 'context', 'boundary'];
DEFINE FIELD IF NOT EXISTS ord ON memory_episode_member TYPE int;
DEFINE FIELD IF NOT EXISTS relevance ON memory_episode_member TYPE float
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD IF NOT EXISTS segmenterVersion ON memory_episode_member TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON memory_episode_member TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS scene_member_uq ON memory_episode_member FIELDS in, out UNIQUE;
DEFINE INDEX IF NOT EXISTS scene_member_out_idx ON memory_episode_member FIELDS out;
DEFINE INDEX IF NOT EXISTS scene_member_ver_idx ON memory_episode_member FIELDS segmenterVersion;

-- GDPR tombstone counter (0080 idiom): scenes erased by an entity forget.
DEFINE FIELD IF NOT EXISTS scenesDeleted ON forgotten_entity TYPE option<int>;
