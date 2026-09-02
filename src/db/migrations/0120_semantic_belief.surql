-- 0120: semantic_belief — the belief substrate (Belief-A): distilled
-- (subject, field) = value state promoted out of enriched scenes
-- (memory_episode stateDeltas, migration 0118), SEPARATE from Claim
-- (knowledge_fact).
--
-- WHY A NEW TABLE. A belief is what the brain currently HOLDS about a
-- free-text (subject, field) key — folded from one or more scenes — not
-- a single-source claim about a resolved knowledge_entity. A
-- beliefKind-on-knowledge_fact discriminator was REJECTED: the fact
-- table's key fields are record<knowledge_entity> (scene stateDeltas
-- carry FREE-TEXT subject/field keys, unresolved by design), and a
-- discriminator would leak beliefs into every serving lane that reads
-- knowledge_fact. fn::resolve_fact reuse was REJECTED for the same
-- reason — its conflict machinery is claim-specific (entity-keyed,
-- source-trust duel semantics).
--
-- SHADOW (0106 doctrine). Nothing on the serving path reads this table.
-- The only writer is the promotion pass (belief-promotion.service.ts,
-- SCENES_BELIEF_PROMOTION, default off) — prod is byte-identical with
-- the flag off, and serving-identical with it on (a read API is a later
-- PR). Derived state: rebuildable from enriched scenes at any time.
--
-- BITEMPORAL VOCABULARY. Carries the knowledge_fact vocabulary —
-- validFrom / validUntil / status / supersededBy — plus an explicit
-- `revision` int: a value change NEVER updates in place; it creates
-- revision N+1 and stamps the old row superseded (supersede chain in
-- code, belief-promotion.service.ts). In-place updates are allowed ONLY
-- for the corroboration counters (sourceSceneIds / conversationIds /
-- corroborationCount / conversationCount / updatedAt). The status enum
-- is the belief-relevant SUBSET of the 0047 fact vocabulary.
--
-- PROVENANCE. sourceSceneIds is the INLINE canonical provenance — it
-- survives PROVENANCE_SUPPORT_EDGES being off; the typed memory_support
-- edges (supported_by belief->scene, contradicted_by / derived_from
-- belief->belief, writer 'belief_promotion') are the ADDITIVE mirror,
-- written only while that flag is on.
--
-- INDEXES: single-field ONLY, deliberately (the 0109/0111 rule): any
-- compound index puts its fields into the 3.2.4 planner class where
-- `DELETE semantic_belief WHERE <field> ...` silently deletes ZERO rows
-- (reproduced on memory_support during the 0116 smoke). Every deleter
-- MUST use the two-step idiom regardless: LET $ids = (SELECT VALUE id
-- ...); DELETE $ids; — the audit-p1-guards spec pins a repo-wide
-- `DELETE semantic_belief WHERE` prohibition. (userId, subject, field,
-- revision) uniqueness is code-enforced via deterministic record ids —
-- a compound UNIQUE index is exactly the trap being avoided.
--
-- NO CHANGEFEED and NO DEFINE EVENT (the 0053/0107 separation
-- rationale): belief statements quote-derive from scene enrichment, and
-- an erased user's beliefs must not stay readable in a feed.
--
-- GDPR: BOTH forget cascades erase beliefs + their memory_support edges
-- UNCONDITIONALLY (rows written while SCENES_BELIEF_PROMOTION /
-- PROVENANCE_SUPPORT_EDGES were on must stay erasable after they are
-- off — the EVIDENCE_SUBSTRATE_ENABLED precedent). user-forget erases
-- by userId (a belief always carries the single-user scope of its
-- scenes — the promotion SKIPS mixed-user/legacy scenes fail-closed,
-- #387 userIds semantics); entity-forget erases by reference through
-- the dying scenes (sourceSceneIds).

DEFINE TABLE IF NOT EXISTS semantic_belief SCHEMAFULL;

-- Single-user scope, inherited from the promoted scenes (never NONE:
-- mixed-user / legacy-userIds scene groups are skipped fail-closed).
DEFINE FIELD IF NOT EXISTS userId ON semantic_belief TYPE string;

-- FREE-TEXT keys from scene stateDeltas ({subject, field, from, to}) —
-- deliberately NOT record<knowledge_entity> (see WHY A NEW TABLE).
DEFINE FIELD IF NOT EXISTS subject ON semantic_belief TYPE string;
DEFINE FIELD IF NOT EXISTS field ON semantic_belief TYPE string;

-- Value payload: the held value, the value it displaced (the delta's
-- `from`, '' when unknown), and the rendered statement. statementSource
-- names the renderer: 'template' (deterministic fold) or 'llm'
-- (SCENES_BELIEF_LLM_SYNTHESIS — optional, degrade-to-template).
DEFINE FIELD IF NOT EXISTS value ON semantic_belief TYPE string;
DEFINE FIELD IF NOT EXISTS priorValue ON semantic_belief TYPE option<string>;
DEFINE FIELD IF NOT EXISTS statement ON semantic_belief TYPE string;
DEFINE FIELD IF NOT EXISTS statementSource ON semantic_belief TYPE string
  ASSERT $value INSIDE ['template', 'llm'];

DEFINE FIELD IF NOT EXISTS confidence ON semantic_belief TYPE float
  ASSERT $value >= 0 AND $value <= 1;

-- Bitemporal + revision chain (the 0047 vocabulary subset).
DEFINE FIELD IF NOT EXISTS revision ON semantic_belief TYPE int
  ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS status ON semantic_belief TYPE string DEFAULT 'active'
  ASSERT $value INSIDE ['active', 'superseded'];
DEFINE FIELD IF NOT EXISTS supersededBy ON semantic_belief TYPE option<record<semantic_belief>>;
DEFINE FIELD IF NOT EXISTS validFrom ON semantic_belief TYPE datetime;
DEFINE FIELD IF NOT EXISTS validUntil ON semantic_belief TYPE option<datetime>;

-- Inline canonical provenance + corroboration counters. Record refs may
-- dangle after a scene-world purge (the source.episodeIds precedent) —
-- the GDPR cascades resolve dying scenes by these stored refs.
DEFINE FIELD IF NOT EXISTS sourceSceneIds ON semantic_belief TYPE array<record<memory_episode>>;
DEFINE FIELD IF NOT EXISTS conversationIds ON semantic_belief TYPE array<string>;
DEFINE FIELD IF NOT EXISTS corroborationCount ON semantic_belief TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS conversationCount ON semantic_belief TYPE int DEFAULT 1;

-- Which promoter + which scene world produced this row (the enricher's
-- readable-composite idiom: promoter version | effective segmenter
-- version — under SCENES_VERSION_FINGERPRINT the fingerprinted string).
DEFINE FIELD IF NOT EXISTS promoterVersion ON semantic_belief TYPE string;

DEFINE FIELD IF NOT EXISTS createdAt ON semantic_belief TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON semantic_belief TYPE datetime DEFAULT time::now();

-- Single-field indexes ONLY — see the header's 3.2.4 planner rationale.
DEFINE INDEX IF NOT EXISTS belief_user_idx ON semantic_belief FIELDS userId;
DEFINE INDEX IF NOT EXISTS belief_subject_idx ON semantic_belief FIELDS subject;
DEFINE INDEX IF NOT EXISTS belief_status_idx ON semantic_belief FIELDS status;

-- Widen the 0116 memory_support writer enum with the promotion pass
-- (DEFINE FIELD OVERWRITE — the 0047/0105 precedent; existing rows all
-- carry values inside the widened list, so this is purely additive).
DEFINE FIELD OVERWRITE writer ON memory_support TYPE string
  ASSERT $value INSIDE ['scene_backlink', 'fact_resolver', 'promotion_runner', 'compaction_runner', 'recompose', 'belief_promotion'];

-- Fulfil the 0106 consolidation-trail contract: consolidatedInto was
-- promised to PR2+ as record<knowledge_fact>, but the column was NEVER
-- written (verified — no writer exists) and beliefs, not facts, are what
-- scenes consolidate into first. Widen to a generic record array so it
-- can hold semantic_belief refs (and knowledge_fact refs later) —
-- OVERWRITE on a never-written column is data-safe by construction.
DEFINE FIELD OVERWRITE consolidatedInto ON memory_episode TYPE option<array<record>>;

-- GDPR tombstone counter (0080 idiom): beliefs erased by an entity
-- forget (scene-mediated — see the header's GDPR paragraph).
DEFINE FIELD IF NOT EXISTS beliefsDeleted ON forgotten_entity TYPE option<int>;
