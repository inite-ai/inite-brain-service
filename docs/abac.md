# ABAC — attribute-based access control for API keys

Scopes answer "may this key search at all"; they cannot answer "may this key
see facts that came from HR documents". ABAC adds named **policy sets** a
tenant attaches to individual API keys. A set carries rules of two kinds:

- **action rules** gate which REST endpoints and MCP tools the key can call,
  by name (`search_knowledge`, `record_fact`, `rest.documents.get`, …) or via
  the macros `@readonly` / `@write` / `@all`;
- **source rules** gate which *rows* (facts, and edges via their `kind`) the
  key can read, by attribute match on the fact's provenance.

Everything is inert unless `ABAC_ENABLED=1` **and** the key references at
least one set — a tenant that never creates a policy runs byte-identical to
pre-ABAC, enforced by a golden e2e.

## The policy document

```jsonc
{
  "name": "support-reader",
  "description": "support agents: read-only, support vertical only, no PII",
  "posture": { "actions": "deny", "reads": "deny" },   // verdict when nothing matches
  "mode": "report_only",                                // report_only | enforce | disabled
  "rules": [
    { "id": "ro",          "effect": "allow", "kind": "action", "actions": ["@readonly"] },
    { "id": "support-only","effect": "allow", "kind": "source",
      "match": [ { "attr": "source.vertical", "op": "eq", "value": "support" } ] },
    { "id": "no-pii",      "effect": "deny",  "kind": "source",
      "match": [ { "attr": "piiClass", "op": "in", "value": ["identifier", "sensitive"] } ] }
  ]
}
```

Evaluation is **deny-overrides** and order-independent:
`explicit deny > explicit allow > default posture`, separately for the action
and read domains. Conditions inside one rule AND together; list values OR. An
absent attribute never matches a value-comparing condition (a rule on
`source.meta.data_class` says nothing about facts without meta); only
`not_exists` matches absence.

Multiple sets on one key combine **most-restrictive**: the final verdict is
allow only if every enforce-mode set allows. `report_only` sets are evaluated
and logged (`would_deny`) but never block — that's the rollout mode.

### Attributes source rules can match

| Attribute | Ops | Notes |
|---|---|---|
| `predicate` | eq, in, prefix | tenant predicate registry ids |
| `piiClass` | eq, in | from the predicate registry (`none/identifier/behavioral/text/sensitive`) |
| `source.vertical`, `source.recorder` | eq, in | who wrote the fact |
| `source.documentId`, `source.originKey` | eq, in (+prefix on originKey) | document lineage |
| `source.meta.<key>` | eq, in, exists, not_exists | operator metadata projected from documents (`IngestDocumentDto.meta`) and direct facts (`IngestFactDto.metadata`), sanitized (`SOURCE_META_STRICT` to reject instead of drop) |
| `trust.authority`, `trust.declaredTrust`, `trust.learnedTrust` | gte, gt, lte, lt | write-time trust snapshot (0..1) — **numeric thresholds, not just equality** |
| `corroboration.count` | gte, gt, lte, lt | distinct confirming origins |
| `provenance.purged` | eq | document text has been erased |
| `userId` | eq, in, exists, not_exists | per-user memory scope (migration 0055) |

The existing `requiresScope` PII gate always runs first and is never weakened
by a policy — ABAC can only narrow further.

### vs. Zep's ABAC (July 2026)

| Capability | Zep | brain |
|---|---|---|
| Action-level allow/deny per key | ✓ | ✓ (REST + MCP, one namespace) |
| Metadata read filtering | equality on projected episode metadata | equality + prefix + **numeric trust thresholds** + corroboration + provenance-purged + piiClass |
| Default-deny / default-allow | per key | per set, per domain (actions/reads) |
| report_only + explain | ✓ (zepctl CLI) | ✓ (API + admin UI) |
| Simulation against real tenant data | ✗ | ✓ (wave 2: run a search as-if holding key X, per-row verdicts) |
| Management surface | CLI + YAML (Enterprise) | REST API + policy editor UI |

## Enforcement points

1. **Action gate** — `ApiKeyGuard` (after the scope check): the handler's
   `@PolicyAction('name')` (fallback: auto-name `"<METHOD> <path>"`, so
   default-deny has no unnamed holes) is evaluated against the key's sets;
   an enforced deny is `403 policy_denied`. The MCP transport route is
   exempt — instead `McpService.buildServer` drops enforce-denied tools from
   registration (they vanish from `tools/list`) and wraps the rest with
   per-call decision telemetry.
2. **Row gate** — `makeRowPolicyFilter` (src/policy/row-filter.ts) applied on
   every read surface: search fusion + edge expansion + backfill,
   `graph_retrieve`, competing facts, entity profile/timeline/connections
   (edges evaluate with `predicate = kind`), code-memory recall. The filter
   reads the request's `PolicyContext` from AsyncLocalStorage (stamped by the
   guard) — no signature threading, MCP and REST share the path. Search legs
   already project `source`/`trustSnapshot`/`corroboration`, so evaluation
   adds no queries; compiled matchers keep the whole-request cost well under
   a millisecond (see `brain_policy_eval_seconds`).

Storage is per-tenant (migration 0056): `access_policy` (documents, zod-caps
64 rules / 32 KB), `policy_binding` (subject → names), `policy_decision`
(observability stream; action decisions per call, row decisions as
per-request aggregates; allows sampled at `POLICY_DECISION_SAMPLE_RATE`).
Resolution is cached per tenant (`POLICY_CACHE_TTL_MS`, default 60 s) — one
query per tenant per TTL, zero per request.

## Rollout runbook

1. Migrate (0056 applies lazily like every migration) and set
   `ABAC_ENABLED=1`. Nothing changes yet — no key references a set.
2. Create a set from a template with `"mode": "report_only"` and attach it to
   one key (`POST /v1/admin/policy-sets/:name/attachments`).
3. Watch `brain_policy_decisions_total{decision="would_deny"}` and the
   `policy_decision` rows. Investigate every divergence with
   `POST /v1/admin/policy-sets/explain`.
4. Clean for a comfortable window → flip the set's `mode` to `enforce` (PUT).
5. Rollback levers, safest first: set `mode` back to `report_only` (PUT, ≤60 s
   to converge) → detach the key → `ABAC_FORCE_REPORT_ONLY=1` + restart
   (demotes every set fleet-wide) → `ABAC_ENABLED=0` + restart.

**Fail-closed:** a key referencing a set name that doesn't resolve gets a
synthetic enforce/deny-all set, a warn log, and
`brain_policy_resolution_errors_total`. Attach-time validation makes this
unreachable through the API — it exists for hand-written JWT claims and
deleted-set races. Alert on the metric.

## Metrics

| Metric | Meaning |
|---|---|
| `brain_policy_decisions_total{decision,kind,mode}` | allow / deny / would_deny, by action-vs-row and set mode. Row decisions count requests, not facts. |
| `brain_policy_eval_seconds` | per-request row-evaluation latency (histogram, buckets from 50 µs). |
| `brain_policy_resolution_errors_total` | fail-closed events — non-zero pages an operator. |
| `brain_policy_sets_active` | enabled sets across tenants (nightly gauge). |

## DB-level fence status (migration 0057)

A second, database-side fence exists but is **prepared, not active**:
`fn::policy_row_denied` plus field PERMISSIONS on
`knowledge_fact.object/objectMeta`, fed by `$caller_policy_deny`
(`ABAC_DB_FENCE_ENABLED`). Verified finding (2026-07-09, canary in
`test/abac-db-fence.e2e-spec.ts`): on the current stack **SurrealDB ignores
field PERMISSIONS for system users** — and `brain_caller` is a NAMESPACE-level
EDITOR, i.e. a system user — and `LET` session variables do not survive a
query() boundary. This applies equally to the pre-existing 0005 PII fence:
**the app-layer JS filters are the only active gate today**, and they cover
every read surface (e2e-enforced). The canary test fails loudly the moment an
upgrade or a move to record users makes PERMISSIONS fire — activate the fence
then, deliberately.
