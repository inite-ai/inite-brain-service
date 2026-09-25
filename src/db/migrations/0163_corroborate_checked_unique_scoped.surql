-- 0163_corroborate_checked_unique_scoped — one memo row per group per scope.
--
-- Rebuilds corroborate_checked_group_idx (0060: entityId, predicate) as
-- (entityId, predicate, scopeKey). Separate file from 0162 on purpose —
-- see there.
REMOVE INDEX IF EXISTS corroborate_checked_group_idx ON corroborate_checked;
DEFINE INDEX IF NOT EXISTS corroborate_checked_group_idx
  ON corroborate_checked FIELDS entityId, predicate, scopeKey UNIQUE;
