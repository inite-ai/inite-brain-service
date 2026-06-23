-- 0035_procedural_memory — third memory tier beyond facts and episodes.
--
-- Procedural memory captures "how to" patterns that should be applied
-- when a matching context appears. It's NOT a fact (no subject /
-- predicate / object triple) and NOT an episode (not tied to a
-- timeline). It's a behaviour rule the agent applies on retrieval.
--
-- Example:
--   trigger = "user asks about pricing"
--   action  = "mention they're on platinum tier; they get 20% off"
--
-- Surface via MCP tools:
--   record_procedure   (brain:write)  — write a new procedure
--   match_procedure    (brain:read)   — cosine-match against trigger
--                                       embedding; return top K
--   list_procedures    (brain:read)   — paginated list for admin UI
--
-- v1 design choices:
--   - One table, schemafull. Both trigger and action are short strings.
--   - trigger_embedding is the cosine-search key — populated at write
--     time by IngestService.embedder. dimension matches the tenant's
--     active embedder (1024d bge-m3 / 1536d openai), enforced via the
--     embedder service rather than the schema.
--   - priority orders ties when two procedures match the same trigger.
--     decay_half_life_days is the future hook for relevance decay; not
--     yet applied at read time (planned for v0.2).
--   - source tracks who recorded it (operator / agent / dreams_loop).
--   - createdAt / retiredAt let an operator soft-retire a procedure
--     without losing the audit row.

DEFINE TABLE IF NOT EXISTS procedural_memory SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS trigger          ON procedural_memory TYPE string;
DEFINE FIELD IF NOT EXISTS triggerEmbedding ON procedural_memory TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS action           ON procedural_memory TYPE string;
DEFINE FIELD IF NOT EXISTS priority         ON procedural_memory TYPE int     DEFAULT 100
    ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS decayHalfLifeDays ON procedural_memory TYPE option<int>;
DEFINE FIELD IF NOT EXISTS source           ON procedural_memory TYPE object FLEXIBLE
    DEFAULT { kind: 'operator' };
DEFINE FIELD IF NOT EXISTS createdAt        ON procedural_memory TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS retiredAt        ON procedural_memory TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS procmem_priority_idx ON procedural_memory FIELDS priority;
DEFINE INDEX IF NOT EXISTS procmem_created_idx  ON procedural_memory FIELDS createdAt;
