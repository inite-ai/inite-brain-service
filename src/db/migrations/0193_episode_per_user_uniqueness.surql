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
-- BACKFILL. Every row gets its keys. Rows that would still collide on
-- (user, conversation, message) — possible where the old index let a NONE
-- through — keep one row as is and get their own id appended to
-- conversationKey, so the UNIQUE index (0198, its own transaction) always
-- builds; no row is deleted. Found by applying this file to a copy of a
-- production tenant before release: the first draft picked "the first row
-- of its group" with a correlated subquery on `$parent`, which does not
-- reach the updated row inside UPDATE … SET on 3.2.4 — every row read as a
-- duplicate. So the keys are written first and the collisions found with a
-- GROUP BY afterwards. No WHERE on an indexed field (the 3.2.4 silent no-op
-- class): the key fields carry no index until 0198, and the second UPDATE
-- addresses ids. A second run is a no-op: every key is set and no group
-- collides any more.

REMOVE INDEX IF EXISTS episode_msg_uq ON episode;

DEFINE FIELD IF NOT EXISTS ownerKey ON episode TYPE string
  VALUE $value ?? ($this.userId ?? '');
DEFINE FIELD IF NOT EXISTS conversationKey ON episode TYPE string
  VALUE $value ?? ($this.conversationId ?? '');

UPDATE episode SET
  ownerKey = userId ?? '',
  conversationKey = conversationId ?? ''
WHERE ownerKey IS NONE OR conversationKey IS NONE;

LET $dupGroups = (
  SELECT ownerKey, conversationKey, messageId, array::group(id) AS ids, count() AS n
    FROM episode
   WHERE ownerKey IS NOT NONE
   GROUP BY ownerKey, conversationKey, messageId
).filter(|$g| $g.n > 1);

FOR $g IN $dupGroups {
  FOR $rid IN array::slice($g.ids, 1) {
    UPDATE $rid SET conversationKey = string::concat(conversationKey, '#', <string>id);
  };
};
