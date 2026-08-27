-- 0118: enrichment revision columns on memory_episode (Drift-3b).
--
-- WHY. The PR2 enricher overwrote the composer's deterministic gist /
-- memoryValue IN PLACE on the scene row: the deterministic originals were
-- destroyed, enriched vs unenriched rows were indistinguishable by version
-- (segmenterVersion unchanged), and the model id that produced the text
-- was never stamped anywhere. Enrichment is now a REVISION beside the
-- originals: the composed row is immutable post-compose — the enricher
-- writes ONLY the enriched* sibling columns below plus its stamps
-- (stateDeltas / unexpectedDetails were always enrichment-owned; the
-- deterministic pass never writes them). A composer re-run naturally
-- produces fresh un-enriched rows and the post-swap hook re-enriches.
--
-- SHADOW. Same guarantee as 0106: nothing on the serving path reads
-- memory_episode — additive option<> fields, no reader, no behavior
-- change anywhere. NO new indexes (nothing queries these columns yet), so
-- the audit-p1-guards index inventory is unchanged.
--
-- NAMING NOTES.
--  * enrichedMemoryValue mirrors memoryValue's per-dimension shape (0106)
--    so a future read lane can serve either side without translation; the
--    scorer stamps its own version + time inside, exactly like the
--    deterministic vector does.
--  * enrichmentVersion is the READABLE `prompt|scorer|model` composite
--    (e.g. `scene-gist-v1|scene-scorer-llm-v1|gpt-4o-mini`) — NOT hashed:
--    cardinality is low and the model id must stay recoverable. It is the
--    enricher's idempotency key: a scene already at the current composite
--    is skipped, so a re-run with unchanged prompt+scorer+model makes zero
--    paid calls.
--  * enrichmentModel duplicates the bare model id out of the composite so
--    ops can filter/audit by model without string-splitting.
--  * gistPromptVersion (0106) is legacy-dead — superseded by
--    enrichmentVersion; kept (like encoderVersion) because dropping a
--    column is a data-destroying operation with zero upside for a dead
--    stamp nothing writes anymore.

DEFINE FIELD IF NOT EXISTS enrichedGist ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue ON memory_episode TYPE option<object>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.novelty ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.contradiction ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.stateChange ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.identity ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.explicitness ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.estimatedUtility ON memory_episode TYPE option<float>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.scorerVersion ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS enrichedMemoryValue.scoredAt ON memory_episode TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS enrichmentModel ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS enrichmentVersion ON memory_episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS enrichedAt ON memory_episode TYPE option<datetime>;
