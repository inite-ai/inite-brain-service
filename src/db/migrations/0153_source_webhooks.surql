-- 0153_source_webhooks — inbound webhooks on source connections
-- (docs/roadmap/crm-sources-2026-09.md § 4.4, W4.2c; docs/source-plane.md
-- § Webhooks). A vendor that can call a URL on change is pointed at the
-- connection's webhook address; the event names the entity + id and the
-- engine fetches that one record through the records door — the same
-- door a sync uses, so the same grounding applies.
--
--   * source_connection.webhookSecret — what authenticates the vendor's
--     call: the brain's own random secret (Pipedrive basic auth, Kommo /
--     custom `?token=`) or the vendor's (a Bitrix24 application token, a
--     HubSpot app's client secret). Encrypted at rest with
--     SOURCE_CREDENTIAL_ENCRYPTION_KEY (`enc:v1:…`), the credential
--     posture; NONE = the webhook is off and the public address answers 404.
--   * source_connection.lastWebhookAt — the last accepted call, for the
--     operator ("is the vendor reaching us?").
-- Additive; option-typed; no data migration.
DEFINE FIELD IF NOT EXISTS webhookSecret ON source_connection TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lastWebhookAt ON source_connection TYPE option<datetime>;
