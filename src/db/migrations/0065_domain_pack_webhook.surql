-- 0065_domain_pack_webhook — per-install webhook secret for external
-- indexer push notifications.
--
-- A pack whose manifest declares indexer.external.callbackUrl gets an
-- HMAC secret generated at install time (returned ONCE in the install
-- response). When ingest routes a document to that pack, Brain POSTs a
-- signed work_available hint to the callbackUrl. Push is a HINT only —
-- the pull API (GET /v1/indexer/work) stays the source of truth, so a
-- missed webhook costs latency, never work.

DEFINE FIELD IF NOT EXISTS webhookSecret ON domain_pack TYPE option<string>;
