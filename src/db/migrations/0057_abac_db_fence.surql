-- 0057_abac_db_fence — ABAC defense-in-depth at the database layer
-- (PREPARED, NOT YET EFFECTIVE — read the finding below).
--
-- Intent: mirror the 0005 PII pattern for ABAC — when a request's key
-- carries enforce-mode deny rules that are PUSHDOWN-SAFE, the scoped
-- connection binds their compiled form to `$caller_policy_deny`
-- (ABAC_DB_FENCE_ENABLED) and field PERMISSIONS null object/objectMeta
-- for matching rows, so a read path that forgot the JS filter leaks
-- NONE values instead of data.
--
-- ── FINDING (2026-07-09, verified by test/abac-db-fence.e2e-spec.ts) ──
-- On the current stack (SurrealDB 3.1.5, brain_caller = NAMESPACE-level
-- system user with EDITOR role) this fence — and the 0005 PII fence —
-- DOES NOT FIRE:
--   1. SurrealDB ignores table/field PERMISSIONS for SYSTEM users;
--      they apply to record (ACCESS/SCOPE) users only. brain_caller is
--      a system user, so every PERMISSIONS clause is skipped.
--   2. Independently, `LET $var` no longer persists across query()
--      boundaries on this driver/server combo — each query() is its
--      own transaction scope — so `$caller_scopes` /
--      `$caller_policy_deny` read as NONE inside later statements.
-- The app-layer JS filters (policy/row-filter.ts, entity-read.helpers)
-- are therefore the ONLY active gate today — they cover every read
-- surface and are e2e-enforced. This migration ships the fence ARMED
-- for the day callers move to record users (or the binding moves
-- inline per-query); the canary test fails loudly if the stack starts
-- honoring PERMISSIONS so the fence can be activated deliberately.
--
-- Pushdown-safe = every condition in the deny rule is an eq/in match
-- on: predicate, source.vertical, source.recorder, source.documentId,
-- source.originKey. Thresholds/meta/postures/allow rules stay
-- app-layer (a partial pushdown would deny rows the app would allow).
-- Compiled by policy/db-fence.ts; shape:
--   [ { predicate: [..]|NONE, vertical: [..]|NONE, recorder: [..]|NONE,
--       documentId: [..]|NONE, originKey: [..]|NONE }, ... ]
-- Every pushed rule carries ≥1 non-NONE list (compiler guarantee).
--
-- array::filter with a closure instead of a FOR loop — stored-fn FOR
-- has the early-return gotchas documented in the 3.x migration notes.

DEFINE FUNCTION OVERWRITE fn::policy_row_denied(
    $predicate: string,
    $source: option<object>,
    $deny: array<object>
) {
    RETURN array::len(array::filter($deny, |$rule: object| {
        RETURN
            ($rule.predicate = NONE OR $predicate INSIDE $rule.predicate)
            AND ($rule.vertical = NONE
                 OR ($source.vertical ?? '') INSIDE $rule.vertical)
            AND ($rule.recorder = NONE
                 OR ($source.recorder ?? '') INSIDE $rule.recorder)
            AND ($rule.documentId = NONE
                 OR ($source.documentId ?? '') INSIDE $rule.documentId)
            AND ($rule.originKey = NONE
                 OR ($source.originKey ?? '') INSIDE $rule.originKey);
    })) > 0;
};

-- Extend the 0005 field gates with the policy-deny check. `?? []`
-- keeps unbound connections on the pass path. Inert for system users
-- (see FINDING) — kept correct so record-user callers inherit the
-- fence the moment they exist.
DEFINE FIELD OVERWRITE object ON knowledge_fact TYPE string PERMISSIONS
    FOR select WHERE
        (predicate NOT IN ['address', 'dob']
         OR ($caller_scopes ?? []) CONTAINS 'brain:read_pii')
        AND (array::len($caller_policy_deny ?? []) = 0
             OR !fn::policy_row_denied(predicate, source, $caller_policy_deny));

DEFINE FIELD OVERWRITE objectMeta ON knowledge_fact TYPE option<object> FLEXIBLE PERMISSIONS
    FOR select WHERE
        (predicate NOT IN ['address', 'dob']
         OR ($caller_scopes ?? []) CONTAINS 'brain:read_pii')
        AND (array::len($caller_policy_deny ?? []) = 0
             OR !fn::policy_row_denied(predicate, source, $caller_policy_deny));
