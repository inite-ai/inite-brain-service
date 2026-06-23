-- 0027_operator_action — write-only audit log of operator HTTP calls.
--
-- audit_event (migration 0023) captures DATA changes: who/what fact
-- got created/updated/deleted. operator_action captures HUMAN ACTIONS:
-- who hit which admin endpoint, with what scopes, what status came
-- back. Together they answer "the dreams ran differently last night
-- — was that a config flip, a manual trigger, or just the daily cron?"
--
-- Per-tenant placement; rows live in the company DB of the actor.
-- Retention is application-side (OperatorActionService prunes past
-- 90 days).

DEFINE TABLE IF NOT EXISTS operator_action SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS ts ON operator_action TYPE datetime
    DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS actor ON operator_action TYPE string;
-- companyId of the API key that made the call.
DEFINE FIELD IF NOT EXISTS scopes ON operator_action TYPE array
    DEFAULT [];
-- Scopes granted to the key (e.g. ['brain:admin','brain:read_pii']).
DEFINE FIELD IF NOT EXISTS method ON operator_action TYPE string;
DEFINE FIELD IF NOT EXISTS path ON operator_action TYPE string;
-- Always /v1/admin/* — the audit middleware filters non-admin routes.
DEFINE FIELD IF NOT EXISTS status ON operator_action TYPE int;
DEFINE FIELD IF NOT EXISTS durationMs ON operator_action TYPE int
    DEFAULT 0;
DEFINE FIELD IF NOT EXISTS query ON operator_action TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS bodySummary ON operator_action TYPE option<object> FLEXIBLE;
-- Truncated body — we cap each scalar at 200 chars and drop nested
-- payloads past depth 2 so an oversized DTO can't blow up the table.

DEFINE INDEX IF NOT EXISTS operator_action_ts_idx
    ON operator_action FIELDS ts;
DEFINE INDEX IF NOT EXISTS operator_action_actor_ts_idx
    ON operator_action FIELDS actor, ts;
DEFINE INDEX IF NOT EXISTS operator_action_path_idx
    ON operator_action FIELDS path;
