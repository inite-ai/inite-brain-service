-- 0171: api_key.circle — a stored key can act in a trust circle.
--
-- docs/roadmap/trust-circles-2026-10.md §3.2–§3.3. A credential bound to
-- a circle writes into it (its rows carry `circle:<id>` in their scope,
-- auth/circle-scope.ts) and reads only it. The env table takes the same
-- field (`"circle": "<id>"` on a BRAIN_API_KEYS entry); this is the
-- stored-key twin, so a tenant can mint a coach's key and an assistant's
-- key that cannot read each other's conversations.
--
-- ADDITIVE. One optional field on the table 0144 defined in the
-- `system` database (and, as every numbered file, defined but unused in
-- the tenant databases). No data mutation: an existing key has no circle
-- and behaves exactly as before.

-- The id's shape ([A-Za-z0-9._-]{1,120}) is validated where keys are
-- issued (IssueKeyDto / the BRAIN_API_KEYS parser), not re-asserted here.
DEFINE FIELD IF NOT EXISTS circle ON api_key TYPE option<string>;
