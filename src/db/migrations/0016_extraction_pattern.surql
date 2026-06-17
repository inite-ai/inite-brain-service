-- 0016_extraction_pattern — learned per-clause extraction cache.
--
-- The extractor's LLM emits facts per clause. The mapping from a
-- clause text to its facts is deterministic in expectation: "Maria is
-- the CTO at Acme" extracts the same predicate+value shape every
-- time the LLM sees it. Per-clause caching captures that determinism
-- and replays it locally on future ingests without an LLM round-trip.
--
-- This is the per-clause counterpart of the chat router's
-- collapse_pattern cache (migration 0015): empty at bootstrap, fills
-- from LLM emissions, operator-reviewable per tenant.
--
-- The per-clause grain is what makes this useful beyond the
-- whole-text LRU in ExtractorCacheService (Sprint E1) — two ingest
-- payloads with different overall text but a shared clause both
-- benefit. Demo example: many TELL inputs include the clause "Maria
-- is the CTO at Acme" or some near-paraphrase — once the LLM
-- processes one, the next replays from cache.
--
-- Sprint E7 (skip gate) consumes this table to decide when the
-- entire LLM call can be skipped — when every local clause has a
-- cached pattern AND a confident local predicate.

DEFINE TABLE IF NOT EXISTS extraction_pattern SCHEMAFULL;

-- Lowercase, NFC-normalised clause text — natural key.
DEFINE FIELD IF NOT EXISTS clauseText   ON extraction_pattern TYPE string;
-- Captured fact templates as JSON. Each template carries the predicate
-- (canonical id post-canonicalize), the verbatim value span, and the
-- confidence the LLM emitted. valueSpan must still appear in the new
-- input clause for the replay to be valid — the consumer (Sprint E7)
-- runs the same span-grounding check before accepting the cached
-- facts.
DEFINE FIELD IF NOT EXISTS facts        ON extraction_pattern FLEXIBLE TYPE array;
-- Captured edge templates as JSON. Each template carries the kind plus
-- relative entity positions in the clause; the consumer maps them to
-- the new clause's entities (Sprint E7).
DEFINE FIELD IF NOT EXISTS edges        ON extraction_pattern FLEXIBLE TYPE array  DEFAULT [];
-- How many times this clause has been observed. Useful for operators
-- triaging the learned set — high-count patterns are battle-tested;
-- one-shot patterns may be brittle.
DEFINE FIELD IF NOT EXISTS sourceCount  ON extraction_pattern TYPE int      DEFAULT 1;
DEFINE FIELD IF NOT EXISTS createdBy    ON extraction_pattern TYPE string   DEFAULT 'llm_auto'
  ASSERT $value IN ['system', 'admin', 'llm_auto'];
DEFINE FIELD IF NOT EXISTS createdAt    ON extraction_pattern TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt    ON extraction_pattern TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS lastUsedAt   ON extraction_pattern TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS extraction_pattern_clause_idx
  ON extraction_pattern FIELDS clauseText UNIQUE;
