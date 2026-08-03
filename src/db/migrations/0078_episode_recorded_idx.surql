-- 0078_episode_recorded_idx — raw-substrate driver v1, surface 4 support
-- (engine architecture audit 2026-08, W1).
--
-- The subscription dispatcher polls `episode WHERE recordedAt > $since
-- ORDER BY recordedAt ASC LIMIT $k` once a minute per subscription per
-- tenant. 0073 indexes (conversationId, occurredAt) only, so that poll
-- was a full table scan plus sort — the cost grows with the substrate
-- while the useful result stays near-empty.
--
-- The public episodes API pages `ORDER BY occurredAt ASC, id ASC`; the
-- leading column is what the planner can use — `id` is not indexable as
-- a field on 3.1.5 ("The field 'id' does not exist", verified against
-- the live stand), and it only breaks ties inside one timestamp anyway.

DEFINE INDEX IF NOT EXISTS episode_recorded_idx ON episode FIELDS recordedAt;
DEFINE INDEX IF NOT EXISTS episode_occurred_idx ON episode FIELDS occurredAt;
