-- 0200: user_tombstone — the record that an end-user was forgotten.
--
-- WHY. POST /v1/users/:userId/forget erases what exists at that moment,
-- but work accepted earlier can still be running: a mention's background
-- extraction, a request whose client timed out, a job that read the
-- user's rows before the erase. When it finishes it would write the
-- person back. The forget now leaves this row, and the write paths drop
-- work accepted at or before `forgottenAt` (src/common/user-tombstone.ts).
-- Work accepted after it is written normally: re-consent is the
-- product's decision, and a fresh forget moves `forgottenAt` forward.
--
-- FIELDS.
--   id           user_tombstone:<hex>, the HMAC-SHA256 of
--                `<companyId>/user:<userId>` under FORGET_HMAC_KEY. No
--                user id, no content. Point reads and writes by record
--                id only, never UPDATE … WHERE.
--   forgottenAt  the latest forget of this user.
--
-- ADDITIVE. A new table, IF NOT EXISTS, no data mutation, no backfill. The
-- previous release ignores it (rolling deploy and rollback are safe); a
-- forget run by the previous release writes no row, as before.

DEFINE TABLE IF NOT EXISTS user_tombstone SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS forgottenAt ON user_tombstone TYPE datetime;
