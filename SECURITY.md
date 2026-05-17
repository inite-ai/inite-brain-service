# Security model + known limitations

inite-brain-service holds per-tenant knowledge graphs — facts,
edges, embeddings derived from vertical traffic. Anything touching
identity, PII gating, or cross-tenant isolation is sensitive. This
ledger tracks what ships today and where SOTA gaps remain.

## What ships today

| Surface | Status |
|---|---|
| ApiKeyGuard with @RequireScopes per route | ✓ |
| Static BRAIN_API_KEYS (dev / fallback) | ✓ |
| JWT verification via auth.inite.ai JWKS | ✓ |
| JWKS cache TTL pinned (`JWKS_CACHE_MAX_AGE_MS`, default 5min) | ✓ |
| Kid allow-list at verify-time (`JWKS_EXPECTED_KIDS`) | ✓ |
| Per-tenant rate limiting (TenantThrottlerGuard, keys by token hash) | ✓ |
| Per-route throttle buckets (forget 5/min, synth 30, search 60, ingest 200) | ✓ |
| Scope-gated destructive ops (`brain:admin` on forget) | ✓ |
| MCP companyId path cross-check vs JWT sub | ✓ |
| PII gating via DB-level PERMISSIONS + `brain:read_pii` scope | ✓ |
| Hard-forget cascade with HMAC tombstone in `forgotten_entity` | ✓ |
| Per-tenant database isolation (one SurrealDB DB per company) | ✓ |
| OTel auto-instrumentation excludes request bodies | ✓ |

## Known limitations (SOTA gaps)

### 1. No active-flag callback to auth-service on destructive ops

**Status:** Mitigated by ≤5min M2M JWT TTL.
**Risk:** When auth-service deactivates a client mid-flight, brain
keeps accepting valid JWTs until expiry. Worst case 5min window
during which destructive ops (forget) can still fire.
**Why deferred:** Short TTL + per-route forget limit (5/min) bounds
the damage. A real-time introspection callback would add latency to
every destructive call and create a hard dependency on auth-service
uptime for cascade flows.
**Trigger to ship:** if forget volume per tenant ever justifies
sub-second revocation, or if regulators demand it.

### 2. No request-body audit on search / synthesize

**Status:** Request line logged (method, path, status, companyId
hash, duration). Body NOT captured.
**Risk:** Operators can prove brain executed forget, but can't
reconstruct what a search query was after the fact — e.g. for an
incident review of "did this user query for someone else's
address?". Mitigation: don't log bodies on purpose (PII risk).
**Why deferred:** Tension between forensics and PII minimisation.
Hard to add hashed/redacted body capture without leaking field
names. Tracked but not actionable until product asks for it.
**Trigger to ship:** SIEM-driven incident response requires query
attribution.

### 3. No idempotency key on forget

**Status:** Throttle gates volume (5/min/tenant), no idempotency.
**Risk:** A retry-storm from a buggy vertical could repeat the
same forget call until throttled. forgotten_entity HMAC tombstone
deduplicates downstream, but the LLM cost of re-running cascades
on already-empty entities is wasted spend.
**Why deferred:** TenantThrottlerGuard + per-route forget limit
of 5/min keeps the loss bounded (max 5 wasted calls/min/tenant).
**Trigger to ship:** if a vertical's GDPR retry logic spams brain
in practice.

### 4. No DPoP / sender-constrained JWTs

**Status:** Plain bearer tokens.
**Risk:** Leaked JWT (TLS termination logs, sidecar leak, container
snapshot) usable until expiry. Mitigated by 5min TTL, audience
binding (auth-service side), kid validation.
**Why deferred:** Heavy coordinated lift across auth-service + the
@inite/auth SDK + brain. Tracked in the auth-service SECURITY.md.
**Trigger to ship:** when bearer-token theft would breach
regulated-data SLAs.

## Reporting

Security disclosures: security@inite.ai (PGP key available on
request). Coordinated disclosure window: 90 days from
acknowledgement.
