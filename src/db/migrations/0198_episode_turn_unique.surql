-- 0198_episode_turn_unique — the per-user turn identity of 0193 as a
-- UNIQUE index over never-NONE key fields.
--
-- Its own file, so the index is defined in a transaction that wrote no
-- rows (SurrealDB 4.0 refuses DEFINE INDEX after writes to the same table
-- in one transaction; 0193 backfills the keys). 0193 left every existing
-- row with a distinct (ownerKey, conversationKey, messageId), so the
-- build cannot fail on old duplicates. Idempotent.

DEFINE INDEX IF NOT EXISTS episode_turn_uq ON episode
  FIELDS ownerKey, conversationKey, messageId UNIQUE;
