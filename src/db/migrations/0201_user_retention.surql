-- 0201: retention_policy — a tenant's rule for erasing people who stopped
-- talking to it (owner decision 2026-11-14: a person's memory is erased two
-- years after their last contact, for the family products).
--
-- WHY. A product keeps a person's memory for as long as the relationship
-- lasts. When the person goes quiet for good, nothing ever asked Brain to
-- forget them. The `user_retention` job reads this row per tenant and runs
-- the user forget (with its tombstone, 0200) for every user whose last
-- write is older than the window.
--
-- FIELDS. One row, `retention_policy:users`.
--   userInactiveDays  days since a user's last write after which the user
--                     is forgotten; NONE = off (the default for every
--                     tenant: an existing tenant never starts erasing
--                     because a release shipped). 30..3650.
--   updatedAt         when the rule was last set.
--
-- ADDITIVE. A new table, IF NOT EXISTS, no data mutation, no backfill. The
-- previous release ignores it.

DEFINE TABLE IF NOT EXISTS retention_policy SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userInactiveDays ON retention_policy TYPE option<int>
    ASSERT $value = NONE OR ($value >= 30 AND $value <= 3650);
DEFINE FIELD IF NOT EXISTS updatedAt ON retention_policy TYPE datetime DEFAULT time::now();
