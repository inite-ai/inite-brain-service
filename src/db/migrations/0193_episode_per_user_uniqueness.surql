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
-- WHY KEY FIELDS. userId (a tenant-global turn) and conversationId are
-- optional, and a UNIQUE index does not enforce uniqueness over NONE
-- (measured on 3.2.4: two tenant-global turns with the same ids both
-- inserted). So the key is carried by two never-NONE fields, ownerKey =
-- userId ?? '' and conversationKey = conversationId ?? '', computed on
-- every write that does not set them (`$value ??` keeps an explicit
-- value, so the backfill below can disambiguate). The old image keeps
-- writing rows without them during a rolling deploy; the VALUE clause
-- fills them in.
--
-- BACKFILL. Every row gets its keys. A row that duplicates an earlier
-- row's (user, conversation, message) — possible where the old index let
-- a NONE through — gets its own id appended to conversationKey, so the
-- UNIQUE index (0198, its own transaction) always builds; no row is
-- deleted. No WHERE on an indexed field (the 3.2.4 silent no-op class):
-- the UPDATE walks the table.

REMOVE INDEX IF EXISTS episode_msg_uq ON episode;

DEFINE FIELD IF NOT EXISTS ownerKey ON episode TYPE string
  VALUE $value ?? ($this.userId ?? '');
DEFINE FIELD IF NOT EXISTS conversationKey ON episode TYPE string
  VALUE $value ?? ($this.conversationId ?? '');

UPDATE episode SET
  ownerKey = userId ?? '',
  conversationKey = IF (
    SELECT VALUE id FROM episode
     WHERE userId = $parent.userId
       AND conversationId = $parent.conversationId
       AND messageId = $parent.messageId
     ORDER BY recordedAt, id
     LIMIT 1
  )[0] = id
    THEN conversationId ?? ''
    ELSE string::concat(conversationId ?? '', '#', <string>id)
  END;
