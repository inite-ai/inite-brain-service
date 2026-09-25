-- 0164_edge_valid_time — a relation holds for a period, like a fact.
--
-- WHY. A knowledge_fact is bitemporal (validFrom/validUntil = when it held
-- in reality; recordedAt/retractedAt = when brain knew it). A
-- knowledge_edge had only knowledge time — createdAt (the ingest instant)
-- and invalidatedAt — and the extractor projected no time for an edge at
-- all. So a relation stated the CURRENT graph whatever the question: on
-- production "на какой модели работал движок brain 22 сентября?" was
-- answered from the edge "brain runs_on gpt-6-luna", written on the 24th
-- from "до 24 сентября движок работал на gpt-5.6-luna; с 24 — на
-- gpt-6-luna". And the one closure path mixed the axes: a superseding
-- fact wrote its own validFrom into invalidatedAt.
--
-- The edge now carries valid time beside knowledge time:
--   validFrom  — when the relation began to hold (the extractor's
--                eventTime, resolved by the same factTiming as a fact's;
--                the moment it was said when it names no day). NONE =
--                began before anything recorded says — a relation stated
--                only as having ended ("until the 24th").
--   validUntil — when it stopped holding (the superseding fact's
--                validFrom). NONE = still holds.
--   invalidatedAt stays the knowledge-time close (when brain learned the
--   relation ended) — the current-state fence and find_related_entities'
--   "as believed at T" read it.
DEFINE FIELD IF NOT EXISTS validFrom ON knowledge_edge TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS validUntil ON knowledge_edge TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS edge_valid_until_idx ON knowledge_edge FIELDS validUntil;

-- Backfill. Until now the closure wrote the valid-time close into
-- invalidatedAt, clamped to createdAt: that value is the edge's
-- validUntil. A close at or before the write means the relation was
-- recorded only as having ended — its start is unknown, not the write.
UPDATE knowledge_edge SET validFrom = createdAt
  WHERE validFrom IS NONE AND invalidatedAt IS NONE;
UPDATE knowledge_edge SET
    validUntil = invalidatedAt,
    validFrom = IF invalidatedAt > createdAt THEN createdAt ELSE NONE END
  WHERE validUntil IS NONE AND invalidatedAt IS NOT NONE;
