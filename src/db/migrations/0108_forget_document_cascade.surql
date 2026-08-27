-- 0108_forget_document_cascade — tombstone counters for the GDPR
-- document cascade.
--
-- The forget services now cascade through the Source layer: EXCLUSIVE
-- source_documents (no other subject's committed fact references them —
-- the fact-mediated contract, see document-purge.util.ts) are fully
-- erased with their source_chunk / candidate / indexer_run rows. The
-- forgotten_entity tombstone is SCHEMAFULL, so it must learn the new
-- counters or they are silently dropped on CREATE (the 0032/0080 lesson).
--
-- option<int> DELIBERATELY (no DEFAULT): NONE distinguishes a pre-fix
-- tombstone (cascade never ran) from a post-fix erase that found nothing
-- to purge (0).
--
-- NUMBERING NOTE: 0108 is the next free slot on this track at build time;
-- if a sibling track lands its own 0108 first, renumber this file (the
-- runner applies by filename order — content has no ordinal dependency).

DEFINE FIELD IF NOT EXISTS purgedSourceDocs   ON forgotten_entity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS purgedSourceChunks ON forgotten_entity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS purgedCandidates   ON forgotten_entity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS purgedIndexerRuns  ON forgotten_entity TYPE option<int>;
