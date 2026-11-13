-- 0193_episode_per_user_uniqueness — a turn is unique per (user,
-- conversation, message), not per (conversation, message).
--
-- WHY. 0073 made (conversationId, messageId) UNIQUE across the whole
-- tenant, and capture is `INSERT IGNORE` that then recovers "the existing
-- row" by that pair. Conversation and message ids are the CLIENT's, and
-- two end users of one client app routinely share them ("main", "1"): the
-- second user's turn was silently dropped and their facts grounded to the
-- FIRST user's episode — cross-user provenance that the second user's
-- forget does not reach. The identity of a turn includes whose turn it is.
--
-- The new key is strictly finer than the old one, so the existing rows
-- already satisfy it: no data changes, no backfill. userId is NONE for a
-- tenant-global turn, and NONE takes part in the key like a value (the
-- same way 0073's optional conversationId always has), so tenant-global
-- turns keep deduplicating among themselves.
--
-- Rolling deploy: the old image's duplicate lookup (conversationId +
-- messageId) still finds its row through episode_conv_idx; removing the
-- coarser index only relaxes a constraint the old image relied on for
-- deduplication within one user, which the new index keeps. Idempotent.

REMOVE INDEX IF EXISTS episode_msg_uq ON episode;
DEFINE INDEX IF NOT EXISTS episode_user_msg_uq ON episode
  FIELDS userId, conversationId, messageId UNIQUE;
