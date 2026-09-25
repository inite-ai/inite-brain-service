-- 0162_corroborate_checked_scope — the corroboration memo is per scope.
--
-- WHY. The nightly corroboration sweep read tenant-global facts only
-- (`userId IS NONE`), so on a deployment whose memory is personal —
-- every fact a user-bound key writes — it never saw a group. It now
-- sweeps each memory slice (the tenant's, and each user's) separately:
-- two users' re-worded duplicates are never one group. Its
-- negative-result memo (0060) is keyed (entityId, predicate), which
-- would let one slice's verdict suppress another's group; the scope is
-- folded into the key as a string that is never NONE ('' for
-- tenant-global) — the rule 0153 set for edges, for the same reason:
-- SurrealDB does not enforce UNIQUE over a NONE component.
--
-- Two files, like 0153/0154: an index defined in the same transaction
-- as the backfill does not enforce on the backfilled rows.
DEFINE FIELD IF NOT EXISTS scopeKey ON corroborate_checked TYPE string DEFAULT '';

-- Every existing memo row judged a tenant-global group.
UPDATE corroborate_checked SET scopeKey = '' WHERE scopeKey IS NONE;
