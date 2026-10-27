import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 2343–3012 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_05: ConfigCatalogSpec[] = [
  {
    key: 'SOURCE_KIND_SLACK',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `slack` source connector (source plane, W4.7 — chat): the channels a Slack app is a member of, through the Web API as the connected workspace's bot token (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_SLACK_CLIENT_ID) or a bot token pasted as the credential. One catalogue row per message (ts + edit ts as the revision), `conversations.history` newest first from `since` on a first walk and from the checkpoint's newest ts after, roots with replies followed into `conversations.replies`; every message enters the mention door as one turn of its channel or thread (chat_memory: `slack`) — the author as the speaker, mrkdwn reduced to text, mentions resolved to names, files named. Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_TELEGRAM',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `telegram` source connector (source plane, W4.7 — chat): the groups, supergroups and channels a Telegram bot is in, read through the Bot API's getUpdates with the bot token as the credential — a FEED: Telegram keeps an update 24 hours and the brain acknowledges what it read by moving the offset, so nothing is re-read and nothing is ever marked gone (readsOnlyNew; a full walk is an incremental one). Every message enters the mention door as one turn of its chat or forum topic (chat_memory: `telegram`), the sender as the speaker, media named. A bot with a webhook set answers 409 — remove it to poll. Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_TELEGRAM_API_BASE',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — swaps https://api.telegram.org for a fake Bot API (the `telegram` connector); the fetches then need the private-egress opt-in (SOURCE_EGRESS_ALLOW_PRIVATE). Unset in production.',
  },
  {
    key: 'SOURCE_OAUTH_SLACK_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The client id of the Slack app the brain connects workspaces through (api.slack.com/apps; the brain's callback URL as a redirect URL; the bot scopes channels:history, channels:read, groups:history, groups:read, users:read). OAuth v2: the answer is the workspace's bot token, no expiry (token rotation is not supported), no PKCE. Unset = Slack is 'not configured' — a bot token can still be pasted as the credential.",
  },
  {
    key: 'SOURCE_OAUTH_SLACK_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description: 'The client secret of the Slack app named by SOURCE_OAUTH_SLACK_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_SLACK_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Slack (slack.com OAuth + Web API) counterpart.',
  },
  {
    key: 'SOURCE_KIND_REST_RECORDS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `rest_records` source connector (source plane, W4.2b′ — the long tail on the records contract, docs/roadmap/crm-sources-2026-09.md § 4.3): a CRM / ERP / ticketing backend with a JSON list API and no connector of its own, described as CONFIG — per entity a list endpoint, where the rows sit in the answer, one of five paging styles (none / page / offset / cursor / link), one updated-since parameter, the id / name / updated-at fields, the relation fields — dotted paths only. The credential rides as `config.authScheme` says (bearer / basic / header:<Name> / query:<name>); a backend on the LAN needs `config.allowPrivate` + SOURCE_EGRESS_ALLOW_PRIVATE. The mapping assistant (POST /v1/admin/source-connections/assist) proposes the config from an OpenAPI document or a sample answer; the preview verifies it. Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_MAPPING_ASSISTANT',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'The model half of the mapping assistant (W4.2b′): with it, POST /v1/admin/source-connections/assist sends the bounded API digest and the deterministic proposal to MAPPING_ASSISTANT_MODEL under a strict JSON schema and keeps what validates — a hallucinated path or predicate is dropped, never trusted. Off (default) = the deterministic proposal only (conventional names for id / name / updated-at / paging / since parameters, a synonym table over the pack vocabulary); the endpoint and the preview work the same, no model is ever called.',
  },
  {
    key: 'SOURCE_WEBHOOKS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Inbound webhooks on the records connectors (source plane, W4.2c — docs/roadmap/crm-sources-2026-09.md § 4.4): `POST /v1/admin/source-connections/:id/webhook` switches a connection's webhook on and hands out the address to register at the vendor (the tenant and the connection under an HMAC of SOURCE_CREDENTIAL_ENCRYPTION_KEY) plus a secret shown once (generated, or the vendor's own — a Bitrix24 application token, a HubSpot app's client secret); the public `POST /v1/source-connections/webhook/:address` takes the vendor's call — HubSpot v3 signature, Pipedrive basic auth, Bitrix24 `auth[application_token]`, Kommo / custom REST `?token=` or an HMAC of the body — parses it into entity + id (+ deleted), and the engine fetches those records through the same records door a sync uses (a queued `source_sync` job, `ranBy: webhook`; a deletion closes the record's facts by the delete policy). The webhook never carries data into memory. Off (default) = both routes answer 404, no address exists, no vendor call is accepted — byte-identical.",
  },
  {
    key: 'MAPPING_ASSISTANT_MODEL',
    category: 'pipeline',
    defaultValue: 'gpt-5.6-luna',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'The model the mapping assistant refines a proposal with (SOURCE_MAPPING_ASSISTANT). One bounded call per proposal; the cheapest current model with structured outputs by default.',
  },
  {
    key: 'SOURCE_OAUTH_CLIENT',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The brain as an OUTBOUND OAuth 2.1 client (source plane, W4): the connected-accounts surface (`POST /v1/admin/source-connections/oauth/start`, `GET …/oauth/grants`, `DELETE …/oauth/grants/:id`), the public callback (`GET /v1/source-connections/oauth/callback`, authenticated by the HMAC-signed state), and the grants the cloud connectors (gdrive, onedrive, dropbox) run as — authorization code + PKCE against a platform provider (Google, Microsoft, Dropbox; the operator's app in SOURCE_OAUTH_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET), the token set encrypted at rest under SOURCE_CREDENTIAL_ENCRYPTION_KEY (required — the client refuses to start without it), refreshed by the engine before a run when it is about to expire, a refusal marking the grant broken by name. Off (default) = the routes answer 404, no provider is ever contacted, no grant exists — byte-identical.",
  },
  {
    key: 'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      "The key source credentials are encrypted with at rest (32 bytes, base64 or 64 hex chars): a connection's `credential` and every OAuth grant's token set are stored as AES-256-GCM ciphertext (`enc:v1:<kid>:…`) and decrypted only on the engine's read. Unset = operator secrets are stored as-is (the pre-W4 posture; a legacy clear value stays readable once the key is set and is re-encrypted on its next write) and no OAuth grant can be made. Rotate by moving the old key to SOURCE_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS. Generate: `openssl rand -base64 32`.",
  },
  {
    key: 'SOURCE_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The previous SOURCE_CREDENTIAL_ENCRYPTION_KEY during a rotation: values it encrypted still decrypt (each ciphertext names its key by id); every write uses the current key. Remove once every credential has been rewritten.',
  },
  {
    key: 'SOURCE_MCP_OAUTH',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The brain as an OAuth client of ANY MCP server (source plane, W4.3 — docs/roadmap/crm-sources-2026-09.md § 4.5): `POST /v1/admin/source-connections/oauth/mcp/start` discovers the server's authorization server from its 401 (RFC 9728 protected-resource metadata, then RFC 8414 / OpenID metadata, path-aware), registers a client there dynamically (RFC 7591; a public PKCE client unless the server issues a secret) or takes one the operator registered, and sends the admin to consent with PKCE and the RFC 8707 `resource`; the grant (`provider: mcp`, its `resource`) refreshes and revokes through the client kept per resource (`source_oauth_client`, the secret encrypted). A pack's `auth: 'oauth'` http MCP source then runs as that grant — the same harvester, the bearer refreshed by the engine. Needs SOURCE_OAUTH_CLIENT + SOURCE_CREDENTIAL_ENCRYPTION_KEY. Off (default) = the route answers 404, no server is ever discovered, such a source fails by name — byte-identical.",
  },
  {
    key: 'SOURCE_OAUTH_REDIRECT_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The callback URL registered at the OAuth providers, when it is not `<public base>/v1/source-connections/oauth/callback` as the admin's request reached the brain (BRAIN_PUBLIC_URL or the forwarded host) — a path prefix at the edge, a canonical host. Unset = derived per request; `GET …/oauth/grants` shows the value in force.",
  },
  {
    key: 'SOURCE_OAUTH_GOOGLE_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The OAuth client id of the Google Cloud app the brain connects Google accounts through (Drive API enabled; the brain's callback URL as an authorized redirect URI). Unset = Google is 'not configured' in the catalogue and no Google account can be connected.",
  },
  {
    key: 'SOURCE_OAUTH_GOOGLE_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description: 'The client secret of the Google app named by SOURCE_OAUTH_GOOGLE_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_MICROSOFT_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The application (client) id of the Entra ID app registration the brain connects Microsoft accounts through (multi-tenant + personal accounts; delegated Files.Read.All / Sites.Read.All / User.Read / offline_access; the brain's callback URL as a Web redirect URI). Unset = Microsoft is 'not configured'.",
  },
  {
    key: 'SOURCE_OAUTH_MICROSOFT_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description: 'The client secret of the Entra app named by SOURCE_OAUTH_MICROSOFT_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_DROPBOX_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The app key of the Dropbox app the brain connects Dropbox accounts through (scoped access; files.metadata.read + files.content.read + account_info.read; the brain's callback URL as a redirect URI). Unset = Dropbox is 'not configured'.",
  },
  {
    key: 'SOURCE_OAUTH_DROPBOX_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description: 'The app secret of the Dropbox app named by SOURCE_OAUTH_DROPBOX_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_GOOGLE_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only: one origin that replaces EVERY Google URL the brain uses (authorize, token, userinfo, the Drive API — paths kept), so a fake provider on loopback can play Google. Honoured only with SOURCE_EGRESS_ALLOW_PRIVATE (the override is a private target). Unset in production — the public hosts are the only ones ever contacted. SOURCE_OAUTH_MICROSOFT_BASE_URL and SOURCE_OAUTH_DROPBOX_BASE_URL do the same for their providers.',
  },
  {
    key: 'SOURCE_OAUTH_MICROSOFT_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Microsoft (login + Graph) counterpart.',
  },
  {
    key: 'SOURCE_OAUTH_DROPBOX_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Dropbox (api + content) counterpart.',
  },
  {
    key: 'SOURCE_EGRESS_ALLOW_PRIVATE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The operator half of the DOUBLE opt-in for network source connectors (url, s3 endpoint, webdav, mcp/http) to reach loopback / private / link-local hosts — a self-hosted wiki or MinIO on the LAN. The other half is `allowPrivate: true` on the connection itself; either alone changes nothing. With both, plain http is also accepted for that connection (a LAN service rarely has a certificate). Never a pack's or a caller's decision. Off (default) = the SSRF fence stands for every source connection.",
  },
  {
    key: 'SOURCE_FS_ROOTS',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Root jail for the `fs` source connector: a `:`-separated list of absolute directories a connection's `config.root` must resolve inside (realpath on both sides, so neither a symlinked root nor a `..` segment escapes). NO default on purpose — unset means no directory is permitted and every fs sync fails with a clear message: brain's own process reading arbitrary host paths is a capability an operator grants by name.",
  },
  {
    key: 'EVIDENCE_QUARANTINE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "External-ingest quarantine seam (migration 0121): registerAsset stamps evidence_asset.quarantineStatus ('clean' internal / 'quarantined' external_ingest) and scan transitions may run; the broker refuses non-clean assets. Off (default) = the field is NEVER written (rows byte-identical), quarantine transitions 503, and origin:'external_ingest' is rejected 503 — fail closed.",
  },
  {
    key: 'EVIDENCE_FRAGMENT_EMBEDDINGS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Representation embeddings: the ONE write seam (addRepresentation) embeds a representation\'s TEXT content when its writer asks for it and stores the vector plus its embeddingSpaceId in derived_representation — the producer the 0109 "WRITE-DEAD" embedding column has been waiting for, and therefore the fragment lane\'s dense leg (empty by construction while the column is null). The processing run caps how many outputs it asks to embed per run, so a many-output run cannot fan out unbounded model calls. Off (default) = the embedder is never called and neither key is written — byte-identical rows. An embedding failure is soft: the row lands without a vector and the run still succeeds.',
  },
  {
    key: 'EVIDENCE_DERIVED_MAX_BYTES',
    category: 'pipeline',
    defaultValue: '1048576',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Derived-output size cap for the processor broker (default 1 MiB): bounds what an adapter may read from a blob AND the byte length of any single derived-representation content — an over-cap output fails the run (reject, never truncate).',
  },
  {
    key: 'EVIDENCE_GROUNDING_STAMP',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, claim-state write side: after fn::resolve_fact returns, stamp knowledge_fact.groundingStatus ('grounded'|'ungrounded') computed from the presence of observational source (episode: ids in source.episodeIds, non-empty source.evidence[], source.conversationId, or an identified source.recorder — a direct record by a named party is the observation) — the stampFactScope post-resolve idiom, best-effort, warn-never-fail. Absent field = legacy row (pre-flag), never backfilled. Off (default) → no extra UPDATE is issued, rows are byte-identical.",
  },
  {
    key: 'EVIDENCE_FAIL_CLOSED_CAPTURE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, fail-closed mention capture: ingestMention requires the L0 episode write (EPISODE_SUBSTRATE_ENABLED) to succeed and stamps the captured episode id into every extracted fact's source.episodeIds — no extraction without a stored observation. Requires EPISODE_SUBSTRATE_ENABLED (env-validation warns on the inconsistent pair). Off (default) → capture stays non-fatal advisory, byte-identical.",
  },
  {
    key: 'EVIDENCE_UNGROUNDED_EXCLUDE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, consolidation gate: the promotion runner excludes ungrounded members (knowledge_fact.groundingStatus='ungrounded') from summary groups — an unfounded claim must not consolidate into long-term memory. Legacy rows (absent field) still promote. Off (default) → member selection byte-identical.",
  },
  {
    key: 'EVIDENCE_UNGROUNDED_SERVING_GATE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, strict serving: on a supported verdict, batch-check the cited facts' groundingStatus; when every citation is ungrounded the answer abstains under reason 'ungrounded_evidence' (the evidence_capability_unmet fourth-branch idiom, 0113). Mixed or legacy support serves. Resolution failure fails open with a warn. Off (default) → no fetch, byte-identical.",
  },
  {
    key: 'EVIDENCE_FRAGMENT_CITATIONS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, fragment citations (MM-zoom PR2): with the fragment lane rendering media evidence (RETRIEVAL_FRAGMENT_LANE), each rendered line carries its [evidence_fragment:...] header and the generator schema gains citedFragmentIds; emitted ids resolve through the rendered-set fence (the FOVEA_L3_EPISODE_CITATIONS idiom: an id not rendered into the prompt is dropped and counted, never surfaced; the citation's excerpt is the RENDERED excerpt, never generator text; dedupe; cap 16) into fragment-arm evidenceCitations carrying assetId + capability. Those citations let the FOVEA_EVIDENCE_CAPABILITY gate PASS for non-text requirements when a matching-modality fragment is cited. Off (default) → no header, no schema field, no resolver — byte-identical even with the lane on.",
  },
  {
    key: 'FOVEA_FRAGMENT_ZOOM',
    category: 'pipeline',
    // Read at call time (fovea-flags fragmentZoomEnabled) on the
    // synthesize post-verifier seam — never captured in a constructor —
    // so a flip takes effect without restart.
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence plane, fragment zoom (MM-zoom PR3): ONE monotone bounded zoom step at the post-verifier seam. On a verifier-fail with a rendered fragment line truncated by the lane's 600-char excerpt cap, fetch the fuller DERIVED TEXT of the same derived_representation rows (cited fragments first, ≤2 fragments, per-fragment chars capped by FOVEA_FRAGMENT_ZOOM_MAX_CHARS) through the lane's own fence stack (tenant → consent → asset-join user fence → media PII → availability), and RE-VERIFY ONLY — the answer is never regenerated. A flipped verdict serves through the normal finalize path (and the L3 ladder then skips on verdict-ok); no flip or any error falls through to the existing downgrade unchanged. Raw bytes stay exclusively behind EVIDENCE_RAW_READ_ENABLED. Runs before/independent of L3, at most once per request. Off (default) → the verifier runs exactly once and no extra read happens — byte-identical.",
  },
  {
    key: 'FOVEA_FRAGMENT_ZOOM_MAX_CHARS',
    category: 'pipeline',
    // Read at call time (fovea-flags fragmentZoomMaxChars) per zoom
    // step; runtime-mutable.
    defaultValue: '4000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Evidence plane, fragment zoom (MM-zoom PR3): per-fragment ceiling on the fuller derived text one zoom step may hand the re-verifier. A positive integer ≤ 100000; unset/blank/out-of-range → 4000. Values at or below the lane's 600-char excerpt cap make no candidate deeper — the step then skips (safe, just useless). Ignored unless FOVEA_FRAGMENT_ZOOM is on.",
  },
  {
    key: 'EVIDENCE_RAW_READ_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Raw-read gateway (MM-3, migration 0125): the ONE surface serving original evidence bytes — GET /v1/evidence/{assetId}/raw(-url), the fragment twins (whole parent-asset bytes under the STRICTEST fragment+asset piiClasses union), and the unauthenticated signed-URL redeem. Full deny-overrides gate ladder (scope → tenant/availability/quarantine → live grants → ABAC rest.evidence.raw → modality consent via a direct fail-closed domain_pack read → media-PII polarity → blob head), every attempt recorded content-free in evidence_access. On by default — the ladder, not the switch, is what protects the bytes. Off = every route answers a bare 404, indistinguishable from absent routes.',
  },
  {
    key: 'EVIDENCE_GRANTS_API_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Sharing surface (MM-4, migration 0122): the three ownership verbs over an existing asset — POST /v1/evidence/{assetId}/grants (share with a user or a pack), GET /v1/evidence/{assetId}/grants (live owners) and DELETE /v1/evidence/grants/{grantId} (revoke, idempotent). Assets are addressed by RECORD ID only, never by byteHash — the surface is deliberately no existence oracle: unknown asset, foreign tenant, dead/quarantined asset, non-owner and media-PII-blocked all answer ONE bare 404 with the same body and the same two DB round-trips. Acting requires the caller to pass the raw-read gateway's own ownership fence (a user-bound key needs its OWN live user grant; an M2M key needs the asset to hold at least one live grant) plus the media-PII polarity (unclassified blocked, `[]` open, classified needs brain:read_media), so nobody can share what they cannot read. ownerKind 'system' is refused (400): system ownership would pin content past every user's GDPR erasure and belongs to the write seam, not to a client. Requires EVIDENCE_SUBSTRATE_ENABLED. On by default. Off = every route answers a bare 404 raised in a guard, BEFORE the global ValidationPipe could turn a malformed body into a route-revealing 400.",
  },
  {
    key: 'EVIDENCE_SIGNED_URL_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    // Masked, like OPENAI_API_KEY. This entry shipped without the flag, so
    // GET /v1/admin/config returned the HMAC key verbatim to any brain:admin
    // caller — and since redeem is unauthenticated by design, holding this
    // signing key IS the capability to read any tenant's raw evidence.
    secret: true,
    description:
      'HMAC-SHA256 secret for minted raw-evidence URL tokens. NO default on purpose — a default would make every deployment mutually forgeable. Boot hard-errors when set shorter than 32 chars while EVIDENCE_RAW_READ_ENABLED is on, and warns when the flag is on without it (streaming works; mint answers 503, redeem 404 until the secret lands). Marked secret: the inspector masks it, because the signature it mints is itself the read capability.',
  },
  {
    key: 'EVIDENCE_SIGNED_URL_TTL_SECONDS',
    category: 'pipeline',
    defaultValue: '300',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Lifetime of a minted raw-evidence URL (default 300 s). Deliberately short: the token is a bearer capability — expiry plus the live-grant re-check at redeem are its only revocation levers.',
  },
  // ── Document pipeline (migrations 0048–0050) ─────────────
  {
    key: 'DOCUMENT_INGEST_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for POST /v1/ingest/document + the /v1/documents/* surface, and the MCP ingest_document tool. On by default. Off = every route 503s and the tool is not registered.',
  },
  {
    key: 'DOCUMENT_MULTI_INDEXER_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Dedicated per-pack indexer runs + relevance router + async fan-out + external work items. Off = only the generalist union pass runs.',
  },
  {
    key: 'INDEXER_OPERATOR_VIEW_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Read-only operator view over the tenant’s installed indexers and their run health (GET /v1/admin/indexers + /v1/admin/indexers/{packId}/runs, scope brain:admin): mode, pack version, last run, window-bounded run/candidate tallies, and — for external packs — publisher poll liveness derived from the claim ledger. On by default. Off = both routes 404. No mutation verbs; nothing about extraction changes either way.',
  },
  {
    key: 'PACK_SEED_INGEST_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Ingest a pack’s seedDocuments through the document pipeline on install (pack_seed_ingest job). Requires DOCUMENT_INGEST_ENABLED; when either is off the install response reports a skip — install never fails because of seeds.',
  },
  {
    key: 'INDEXER_EXTERNAL_PENDING_TTL_DAYS',
    category: 'pipeline',
    defaultValue: '7',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How long an unclaimed external work item (pending external indexer_run, GET /v1/indexer/work) stays pollable before the nightly sweep expires it. Claimed work rides INDEXER_RUN_STALE_MINUTES via heartbeat.',
  },
  {
    key: 'INDEXER_WEBHOOK_PUSH_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Signed work_available webhook hints to external packs declaring indexer.external.callbackUrl. Best-effort (retries + per-URL breaker); polling stays the source of truth.',
  },
  // ── HTTP edge ─────────────────────────────────────────────
  {
    key: 'TRUST_PROXY',
    category: 'misc',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      "How much of X-Forwarded-For to believe, in Express's `trust proxy` form. Unset/0 = off (the default): every request is attributed to the socket address, so behind a reverse proxy EVERY anonymous caller shares one rate-limit bucket — the mechanism behind the 2026-09-10 outage. `1` = trust one hop (one Traefik/nginx in front of the app), `2` = two, `loopback` or a CIDR list = trust those addresses, `true` = trust the whole chain (only on a closed network; the leftmost entry is client-controlled). Read once at boot: it configures the Express app.",
  },
  {
    key: 'LOG_FORMAT',
    category: 'misc',
    defaultValue: null,
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      '`json` = one JSON object per line for every log line the process writes — the request log AND the Nest logger (level, context, message) — the shape a log shipper files by level; `text` = human-readable lines for `tail -f`. Unset: json in production, text elsewhere. Production also drops debug/verbose lines regardless of format (a 60-second capability probe and the throttle sweep each wrote one per tick).',
  },
  // ── MCP tool profiles ─────────────────────────────────────
  {
    key: 'MCP_TOOL_PROFILE_DEFAULT',
    category: 'misc',
    defaultValue: 'full',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How much of the MCP tool surface a connection lists when its URL does not say. `full` (default) lists everything the credential unlocks — 20 tools read-only, up to 32 with write and admin. `core` lists six plus find_tool / run_tool, which reach the rest on demand: the same capability at roughly a quarter of the tools/list context cost. `chatgpt` serves exactly the search + fetch pair ChatGPT connectors require. A `?tools=` parameter on the MCP URL overrides this per connection.',
  },
  {
    key: 'MCP_TOOL_PROFILE_OVERRIDES',
    category: 'misc',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Per-tenant MCP tool profile — JSON object mapping companyId → profile name (`full` | `core` | `chatgpt`), the RETRIEVAL_PROFILE_OVERRIDES idiom: read at call time so a change needs no restart, and a malformed or unknown entry falls open to MCP_TOOL_PROFILE_DEFAULT for that tenant instead of failing its requests. "Which tools does my agent see" is a per-workspace decision, so a shared deployment must not force one answer on every tenant. A `?tools=` parameter on the MCP URL still wins over this.',
  },
  // ── MCP pack tools (migration 0068) ───────────────────────
  {
    key: 'MCP_PACK_TOOLS_ENABLED',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for pack-declared MCP tools (installed packs with a consented mcpTools section). Off = the MCP surface is exactly the static tool families.',
  },
  {
    key: 'MCP_PACK_QUERY_TOOLS_ENABLED',
    category: 'misc',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Declarative query tools (search / facts_by_predicate over the pack’s own predicates). Default ON under the master flag; only reachable when MCP_PACK_TOOLS_ENABLED=1.',
  },
  {
    key: 'MCP_PACK_EXTERNAL_TOOLS_ENABLED',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'HMAC-signed HTTPS proxy tools to publisher endpoints (opaque installId on the wire, never companyId). Off = external tool specs are ignored even when consented.',
  },
  {
    key: 'MCP_PACK_TOOLS_ALLOW_HTTP',
    category: 'misc',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Dev/test ONLY: permit plain-http + loopback/private external tool endpoints (disables the SSRF egress guard). Never enable in production.',
  },
  {
    key: 'MCP_PACK_TOOLS_CACHE_TTL_MS',
    category: 'misc',
    defaultValue: '30000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'TTL of the per-tenant pack-tool binding cache on the MCP hot path. Install/uninstall invalidate immediately; the TTL covers out-of-band domain_pack edits.',
  },
  // ── Search: retrieval-evolution stages (migrations 0052–0055) ──
  {
    key: 'SEARCH_HNSW_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Switch the KNN vector leg on. Tenants without a built index fall back to the full scan; build via POST /v1/admin/maintenance/hnsw (every build is CONCURRENTLY; `waitMs` in the request body bounds how long that call holds for the build, default 60 s). Check `ready` in the response before flipping this for a tenant. Provisioning (the schema-ready hook and the nightly sweep) follows this flag unless HNSW_PROVISION_ENABLED says otherwise.',
  },
  // ── HNSW index provisioning + reconciliation ──
  // Category 'jobs', not 'search': these gate a scheduled maintenance pass
  // and a provisioning hook, never a retrieval code path. They sit beside
  // SEARCH_HNSW_ENABLED in the runbook.
  {
    key: 'HNSW_PROVISION_ENABLED',
    // No default of its own: UNSET is DERIVED FROM SEARCH_HNSW_ENABLED
    // (HnswProvisionService.enabled()), so declaring '0' here told an
    // operator provisioning was off while a tenant riding the KNN legs had
    // it on.
    category: 'jobs',
    defaultValue: null,
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Unset → DERIVED FROM SEARCH_HNSW_ENABLED (no default of its own). Give every tenant its HNSW indexes without a human remembering: (a) a hook on SurrealService.ensureSchema — the one place a tenant database is created — notes each tenant and provisions it off the request path; (b) a leader-elected nightly sweep (05:10 UTC) reconciles the roster within HNSW_PROVISION_TIME_BUDGET_MS and HNSW_PROVISION_MAX_BUILDS_PER_RUN; (c) every observation lands in tenant_registry (indexState/indexStateAt/embeddingSpace), so GET /v1/admin/maintenance/hnsw/roster answers with no DDL. Provisioning only ever ADDS absent indexes, always CONCURRENTLY, and never waits for a build. UNSET (the normal case) it FOLLOWS SEARCH_HNSW_ENABLED — a deployment riding the KNN legs wants every tenant indexed; set it explicitly only to build ahead of flipping the search flag (1) or to hold provisioning back while the search flag is on (0).',
  },
  {
    key: 'HNSW_PROVISION_TIME_BUDGET_MS',
    category: 'jobs',
    defaultValue: '600000',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Wall-clock budget for one reconciliation walk. Tenants not started are counted (skippedForBudget), never dropped — an un-indexed tenant is rediscovered by the next walk. Keep it below the 20-minute lease TTL, or a run can outlive its own lease and let a second pod start a parallel pass.',
  },
  {
    key: 'HNSW_PROVISION_MAX_BUILDS_PER_RUN',
    category: 'jobs',
    defaultValue: '5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How many tenants may START index builds in one reconciliation run. Bounds the blast radius of the FIRST run after enablement, which is the only one that finds a backlog: converging 200 un-indexed tenants over 40 nights costs nothing, converging them in one pass puts 4 × 200 concurrent HNSW builds on one SurrealDB. Tenants held back by the cap are still PROBED and recorded, so the roster tells the truth about them the same night.',
  },
  {
    key: 'SEARCH_USAGE_RECORDING_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description: 'Record lastReadAt on retrieved facts (feeds recency decay).',
  },
  {
    key: 'SEARCH_USAGE_DECAY_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Count recency decay from lastReadAt, not only recordedAt (needs recording on for data). Legacy self-reinforcing signal — retrieval alone restarts the decay clock; prefer RETRIEVAL_VERIFIED_USE_DECAY (see 0107).',
  },
  {
    key: 'SEARCH_USAGE_RANKING_ENABLED',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'G8 trace-derived ranking (Spectron "eight signals"): fold fact_usage.readCount into ranking as a bounded, saturating multiplier (× (1 + SEARCH_USAGE_BETA·squash(readCount))). ORDERING DEPENDENCY: enable SEARCH_USAGE_RECORDING_ENABLED first, or readCount never accrues and the signal is inert. Also needs SEARCH_USAGE_BETA > 0 (default 0 = no effect even when on). Legacy self-reinforcing signal — readCount grows on every surfacing; prefer RETRIEVAL_VERIFIED_USE_RANKING (see 0107).',
  },
  {
    key: 'RETRIEVAL_VERIFIED_USE_DECAY',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Verified-use activation, time (profile field verifiedUseDecay; 0107 outcome telemetry): attach memory_outcome_stat.lastVerifiedUseAt to fused candidates — the last VERIFIED use (verifier-supported / user-confirmed) is a trace in the fact's ACT-R activation (search/internals/activation.ts: every event a power-law trace, d = 0.5, the predicate half-life sets the scale). Mere retrieval is not a use. Needs OUTCOME_TELEMETRY_ENABLED writers to have accrued stats. Off = the fact fades from its creation.",
  },
  {
    key: 'RETRIEVAL_VERIFIED_USE_RANKING',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Verified-use activation, count (profile field verifiedUseRanking; 0107): attach verifiedUseScore (memory_outcome_stat verifiedUseCount + confirmedCount) — how many verified uses the fact's ACT-R activation sums (search/internals/activation.ts), so a fact used often stays available though its last use is old. A VERIFIED signal, never the self-reinforcing readCount. Needs OUTCOME_TELEMETRY_ENABLED writers for data. Off = one use when a last-use time is attached.",
  },
  {
    key: 'RETRIEVAL_TENANT_DECAY',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Tenant-aware read-time decay (profile field tenantDecayPolicy): scoring resolves decay half-lives through the per-tenant knowledge_predicate registry lookup already warmed for the row fence (zero extra IO) instead of the legacy code-seed policyFor — an operator-set decayHalfLifeDays on a tenant predicate actually shapes read-time decay. Registry absent / predicate miss falls back to the seed / 60-day default = legacy-identical. Default off = byte-identical.',
  },
  {
    key: 'SEARCH_USAGE_BETA',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Strength of the G8 usage ranking factor: usageFactor = 1 + β·squash(readCount), same multiplicative shape as SEARCH_TRUST_BETA. 0 (default) = off (factor 1.0, byte-identical ranking). Only takes effect with SEARCH_USAGE_RANKING_ENABLED on and recording having accrued reads. Start small, e.g. 0.1.',
  },
  {
    key: 'SEARCH_USAGE_SATURATION',
    category: 'search',
    defaultValue: '20',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'readCount at which the G8 usage squash saturates (~1.0), so the boost ceiling is 1 + SEARCH_USAGE_BETA. log1p-shaped: early reads move the factor most, a hot fact never dominates. Positive integer; default 20.',
  },
  {
    key: 'SEARCH_EDGE_EXPANSION_TOP_SEEDS',
    category: 'search',
    defaultValue: '3',
    runtimeMutable: true,
    isBooleanFlag: false,
    description: 'How many top-ranked seeds edge-expansion walks from.',
  },
  {
    key: 'SEARCH_EDGE_EXPANSION_MAX_NEIGHBOURS',
    category: 'search',
    defaultValue: '5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description: 'Max neighbours pulled per seed during edge-expansion.',
  },
  {
    key: 'SEARCH_EDGE_EXPANSION_ALPHA',
    category: 'search',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Inherited-score multiplier for an edge-expanded neighbour; 0 (the default since 2026-08-15) disables edge expansion entirely — the LoCoMo dev-5 ablation on the one edge-bearing eval world measured NULL (ON 75.3 vs OFF 74.8, n=762 paired McNemar, p=0.61, inside the same-config replication noise floor), so the default search path stops paying two graph round-trips. Set 0.4 (the historical value; keep ≤0.4 so a neighbour never outranks its seed) to re-enable per tenant.',
  },
  {
    key: 'SEARCH_CHATTER_PENALTY',
    category: 'search',
    defaultValue: '1.0',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Sub-1.0 ranking multiplier on low-value "said" chatter facts so substantive facts of the same entity are not buried. 1.0 = off; a demotion needs a value in (0,1), e.g. 0.35.',
  },
  {
    key: 'SEARCH_FACT_CENTRIC_BUDGET',
    category: 'search',
    defaultValue: '48',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Global fact budget for fact-centric selection — total facts kept across all entities (also the per-entity render cap). Default-profile input (RetrievalProfile.factBudget); per-tenant override via RETRIEVAL_PROFILE_OVERRIDES.',
  },
];
