-- 0077_episode_subscription — raw-substrate driver v1, surface 4
-- (docs/roadmap/raw-substrate-driver-2026-08.md).
--
-- Registered webhook endpoints for new-episode notifications, so external
-- projection builders learn about fresh L0 rows without polling the read
-- API. Deliberately NOT changefeed-driven: 0073 keeps the episode table
-- feed-free (a 30-day INCLUDE ORIGINAL feed would keep forgotten verbatim
-- text readable after a GDPR delete). The dispatcher polls per-tenant
-- watermarks over recordedAt (ingest time — monotone, unlike occurredAt
-- which can be backdated) and pushes METADATA ONLY (ids, conversation,
-- speaker, timestamps — never text), so no PII crosses this surface; the
-- subscriber pulls bodies through GET /v1/episodes under its own scopes.
--
-- Delivery is at-least-once: the watermark advances via CAS after a 2xx,
-- duplicate pushes are possible and the payload says so.

DEFINE TABLE IF NOT EXISTS episode_subscription SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS url ON episode_subscription TYPE string;
DEFINE FIELD IF NOT EXISTS secret ON episode_subscription TYPE string;
DEFINE FIELD IF NOT EXISTS active ON episode_subscription TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS watermark ON episode_subscription TYPE datetime;
DEFINE FIELD IF NOT EXISTS failureCount ON episode_subscription TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS createdAt ON episode_subscription TYPE datetime DEFAULT time::now();
