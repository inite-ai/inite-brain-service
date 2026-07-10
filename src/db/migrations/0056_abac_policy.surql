-- 0056_abac_policy — attribute-based access control, storage side.
--
-- Scopes (brain:read/write/admin/read_pii) are coarse: any key holding
-- brain:read can read the tenant's entire graph. ABAC adds named policy
-- sets a tenant attaches to individual API keys: action rules gate which
-- endpoints/MCP tools the key can call, source rules gate which facts it
-- can read by attribute match (predicate, piiClass, source.*, trust
-- thresholds, corroboration, provenance). Evaluation is deny-overrides
-- (explicit deny > explicit allow > per-domain default posture), multiple
-- sets on a key combine most-restrictive, report_only sets log but never
-- block. Everything is inert unless ABAC_ENABLED=1 AND a key references
-- at least one set.
--
-- Three tables, all per-tenant (the co_<companyId> database):
--   * access_policy   — one row per policy set; the rule document is a
--                       FLEXIBLE object validated by zod at CRUD time
--                       (PolicyDocumentSchema), not by the schema here.
--   * policy_binding  — subject ('key:<keyHash>') → set names. JWT-minted
--                       keys carry names in a `policy` claim instead;
--                       bindings cover static keys.
--   * policy_decision — append-only decision stream for report_only
--                       observability and the admin decisions feed.
--                       Row-kind rows are per-request aggregates
--                       (rowCounts), never per fact — bounded volume.
--                       Pruned app-side after 30 days.

DEFINE TABLE IF NOT EXISTS access_policy SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS name      ON access_policy TYPE string;
DEFINE FIELD IF NOT EXISTS mode      ON access_policy TYPE string
    ASSERT $value IN ['report_only', 'enforce', 'disabled'] DEFAULT 'report_only';
DEFINE FIELD IF NOT EXISTS document  ON access_policy TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS version   ON access_policy TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS createdAt ON access_policy TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON access_policy TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedBy ON access_policy TYPE string;

DEFINE INDEX IF NOT EXISTS access_policy_name_idx ON access_policy FIELDS name UNIQUE;

DEFINE TABLE IF NOT EXISTS policy_binding SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS subject     ON policy_binding TYPE string;
DEFINE FIELD IF NOT EXISTS policyNames ON policy_binding TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS updatedAt   ON policy_binding TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS policy_binding_subject_idx ON policy_binding FIELDS subject UNIQUE;

DEFINE TABLE IF NOT EXISTS policy_decision SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS ts        ON policy_decision TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS keyHash   ON policy_decision TYPE string;
DEFINE FIELD IF NOT EXISTS kind      ON policy_decision TYPE string
    ASSERT $value IN ['action', 'row'];
DEFINE FIELD IF NOT EXISTS decision  ON policy_decision TYPE string
    ASSERT $value IN ['allow', 'deny', 'would_deny'];
DEFINE FIELD IF NOT EXISTS mode      ON policy_decision TYPE string
    ASSERT $value IN ['report_only', 'enforce'];
DEFINE FIELD IF NOT EXISTS action    ON policy_decision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS policySet ON policy_decision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS ruleId    ON policy_decision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS requestId ON policy_decision TYPE option<string>;
-- Row-kind aggregates: how many rows the request surfaced vs how many
-- this policy denied (or would deny) — {total, denied}. Sampled
-- per-fact detail rides in sampleFactIds/samplePredicates, capped by
-- the sink.
DEFINE FIELD IF NOT EXISTS rowCounts ON policy_decision TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS sampleFactIds ON policy_decision TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS samplePredicates ON policy_decision TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS sampled   ON policy_decision TYPE bool DEFAULT false;

DEFINE INDEX IF NOT EXISTS policy_decision_ts_idx ON policy_decision FIELDS ts;
