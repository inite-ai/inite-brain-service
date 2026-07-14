-- 0060_corroborate_checked — negative-result memo for the nightly
-- corroboration pass.
--
-- DreamsCorroborateService selects its nightly window deterministically
-- (most-populated groups first — wave F4). A group whose pairs are all
-- judged 'different'/'unsure' applies nothing, so nothing about it
-- changes — it re-qualifies every night and, being deterministically
-- sorted to the top, permanently occupies a window slot. Once enough
-- persistently-different groups exist, the window is 100% stuck groups:
-- backlog drain rate goes to zero while the nightly LLM spend stays
-- maximal.
--
-- The memo records (entityId, predicate, memberCount) after a group is
-- processed. A group is skipped while its CURRENT active-member count
-- equals the memo'd one; any membership change (new fact, retraction,
-- a member turning 'corroborating') changes the count and re-qualifies
-- the group. A same-count membership swap is a false skip — accepted:
-- the memo is a cost gate, not a correctness gate, and the swap case
-- self-heals on the next count change.

DEFINE TABLE IF NOT EXISTS corroborate_checked SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS entityId    ON corroborate_checked TYPE record<knowledge_entity>;
DEFINE FIELD IF NOT EXISTS predicate   ON corroborate_checked TYPE string;
DEFINE FIELD IF NOT EXISTS memberCount ON corroborate_checked TYPE int;
DEFINE FIELD IF NOT EXISTS checkedAt   ON corroborate_checked TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS corroborate_checked_group_idx
  ON corroborate_checked FIELDS entityId, predicate UNIQUE;
