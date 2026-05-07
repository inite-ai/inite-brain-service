-- 0004_knowledge_artifact — compilation-stage knowledge layer.
--
-- The motivating premise (cf. Pinecone Nexus, VentureBeat 2026-05-04):
-- agentic callers don't want raw facts re-retrieved per session. They
-- want pre-built, task-shaped, citation-stamped artifacts that a
-- downstream model can consume verbatim without re-interpretation.
--
-- A `knowledge_artifact` is a typed bundle composed from the current
-- fact set for a given entity at compile time. Examples:
--   `customer_profile`  — name + tier + status + recent contact info
--   `support_context`   — recent complaints + interactions + open issues
--   `risk_snapshot`     — financial-trust signals + identity merges
--
-- The bundle is persisted with the source-fact ids that drove it, the
-- compile timestamp, and a stale-after window. Reads are served from
-- this table (one round-trip, deterministic shape) with field-level
-- citations back to the originating facts. On stale-or-miss the
-- service rebuilds; the underlying CHANGEFEED on knowledge_fact lets
-- a downstream invalidator mark artifacts dirty proactively.

DEFINE TABLE IF NOT EXISTS knowledge_artifact SCHEMAFULL
    CHANGEFEED 30d INCLUDE ORIGINAL;

DEFINE FIELD IF NOT EXISTS entityId       ON knowledge_artifact TYPE record<knowledge_entity>;
-- artifactType is a free-form string; the application service enforces
-- which types exist by registering compile templates. Verticals can
-- ship domain-specific types (tenant_dossier, patient_summary,
-- listing_card, attendee_history, …) without a schema migration.
-- The ASSERT enum was removed in 0004.1 to support per-vertical
-- templates (registry/verticals.yaml has 15+ verticals each with
-- distinct artifact shapes).
DEFINE FIELD IF NOT EXISTS artifactType   ON knowledge_artifact TYPE string;
DEFINE FIELD IF NOT EXISTS payload        ON knowledge_artifact FLEXIBLE TYPE object;
DEFINE FIELD IF NOT EXISTS sourceFactIds  ON knowledge_artifact TYPE array<record<knowledge_fact>>;
DEFINE FIELD IF NOT EXISTS builtAt        ON knowledge_artifact TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS staleAfterMs   ON knowledge_artifact TYPE int DEFAULT 300000;
DEFINE FIELD IF NOT EXISTS dirty          ON knowledge_artifact TYPE bool DEFAULT false;

-- One artifact per (entity, type). Recompiling overwrites in place.
DEFINE INDEX IF NOT EXISTS knowledge_artifact_unique
    ON knowledge_artifact FIELDS entityId, artifactType UNIQUE;

DEFINE INDEX IF NOT EXISTS knowledge_artifact_type_idx
    ON knowledge_artifact FIELDS artifactType;
DEFINE INDEX IF NOT EXISTS knowledge_artifact_stale_idx
    ON knowledge_artifact FIELDS dirty, builtAt;

-- ─── DEFINE EVENT — auto-mark artifacts dirty on relevant fact changes
-- When any knowledge_fact for an entity changes (CREATE/UPDATE/DELETE),
-- mark every artifact for that entity dirty. The next read will trigger
-- recompilation. This is cheap: a single UPDATE WHERE on the artifact
-- table indexed by entityId. The actual recompile happens lazily on
-- read, not eagerly on write — write amplification stays bounded.
DEFINE EVENT IF NOT EXISTS knowledge_artifact_invalidate
    ON TABLE knowledge_fact
    WHEN $event = 'CREATE' OR $event = 'UPDATE' OR $event = 'DELETE'
    THEN {
        LET $eid = IF $event = 'DELETE' THEN $before.entityId ELSE $after.entityId END;
        UPDATE knowledge_artifact SET dirty = true WHERE entityId = $eid;
    };
