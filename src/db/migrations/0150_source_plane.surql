-- 0150_source_plane — the source plane (docs/roadmap/raw-evidence-sources-2026-09.md § 5.2).
--
-- Everything downstream of "here are the bytes" existed; nothing upstream
-- did. Two new tables and one consent pair:
--
--   * domain_pack.acceptedSources(+Checksum) — install-time consent for the
--     manifest's `sources` section (sources-consent.ts), the 0068 / 0112
--     mold: stamped when declared, cleared when an upgrade drops it,
--     re-required when the section changes.
--   * source_connection — Onyx's connector–credential pair, homed on an
--     installed pack's source entry: the operator's decision to READ one
--     external system, with its config, schedule, policies, checkpoint and
--     lifecycle. `sourceKey` is its source_registry identity
--     (`vertical:recorder`), so per-recorder trust learning rides free.
--   * source_item — the catalogue: one row per external item per connection,
--     identity by LOCATION (connectionId, externalId), never by content.
--     `evidence_asset` cannot carry this (byteHash UNIQUE NOT NULL — an item
--     we have only SEEN has no bytes; two locations with identical bytes are
--     one asset but two catalogue entries with independent lifecycles). The
--     row links to whatever it produced (assetId / documentId / episodeId)
--     and carries the revision the drift sweep compares against.
--
-- Credentials: `credential` is an option<string> in the tenant DB — the
-- domain_pack.webhookSecret posture (0065). W4 encrypts the column; W0–W3
-- store nothing in it but a publisher's install secret reference.
--
-- Per-user scope: both tables carry the 0055 `userId` + 0093 `scope` shape
-- so a personal connection's rows are user-fenced by construction.
--
-- Indexes: single-field only where a WHERE-driven UPDATE/DELETE may run
-- (the 3.2.4 compound-index planner gotcha, PR #372 class); the UNIQUE
-- compound on source_item is an INSERT fence, and every mutation against it
-- pre-selects ids (LET → UPDATE), never UPDATE … WHERE on the pair.

DEFINE FIELD IF NOT EXISTS acceptedSources ON domain_pack TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS acceptedSourcesChecksum ON domain_pack TYPE option<string>;

-- ── source_connection ────────────────────────────────────────────────────
DEFINE TABLE IF NOT EXISTS source_connection SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS packId ON source_connection TYPE string;
DEFINE FIELD IF NOT EXISTS sourceId ON source_connection TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON source_connection TYPE string
  ASSERT $value INSIDE ['mcp', 'native', 'external'];
-- The connector this connection runs (a native's `connector`, 'mcp', or
-- 'external' — an external connection is a catalogue the publisher fills).
DEFINE FIELD IF NOT EXISTS connector ON source_connection TYPE string;
DEFINE FIELD IF NOT EXISTS shape ON source_connection TYPE string
  ASSERT $value INSIDE ['document', 'conversation', 'binary', 'structure'];
-- 'server' = brain's own process runs the connector; 'agent:<id>' = a
-- local agent does, and pushes through the doors (the server never holds
-- that host's credentials).
DEFINE FIELD IF NOT EXISTS host ON source_connection TYPE string DEFAULT 'server';
DEFINE FIELD IF NOT EXISTS label ON source_connection TYPE option<string>;
-- Connector configuration — never secrets (those go in `credential`).
DEFINE FIELD IF NOT EXISTS config ON source_connection TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS credential ON source_connection TYPE option<string>;
DEFINE FIELD IF NOT EXISTS mode ON source_connection TYPE string DEFAULT 'synced'
  ASSERT $value INSIDE ['synced', 'linked'];
DEFINE FIELD IF NOT EXISTS schedule ON source_connection TYPE string DEFAULT 'manual'
  ASSERT $value INSIDE ['manual', '15m', '1h', '4h', '24h'];
DEFINE FIELD IF NOT EXISTS contentPolicy ON source_connection TYPE string DEFAULT 'text'
  ASSERT $value INSIDE ['manifest', 'text', 'bytes'];
DEFINE FIELD IF NOT EXISTS deletePolicy ON source_connection TYPE string DEFAULT 'close'
  ASSERT $value INSIDE ['close', 'retract', 'keep'];
-- Items fetched per sync run; NONE = unbounded.
DEFINE FIELD IF NOT EXISTS fetchBudget ON source_connection TYPE option<int>;
DEFINE FIELD IF NOT EXISTS status ON source_connection TYPE string DEFAULT 'active'
  ASSERT $value INSIDE ['active', 'paused', 'deleting'];
-- Opaque per-connector cursor (Drive pageToken, git commit, fs snapshot…).
DEFINE FIELD IF NOT EXISTS checkpoint ON source_connection TYPE option<object> FLEXIBLE;
-- Ingest identity: contextRef.vertical for every item, and the recorder
-- (= this connection) the facts carry; sourceKey = vertical:recorder.
DEFINE FIELD IF NOT EXISTS vertical ON source_connection TYPE string;
DEFINE FIELD IF NOT EXISTS recorder ON source_connection TYPE string;
DEFINE FIELD IF NOT EXISTS sourceKey ON source_connection TYPE string;
DEFINE FIELD IF NOT EXISTS lastSyncAt ON source_connection TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lastSyncStatus ON source_connection TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lastError ON source_connection TYPE option<string>;
DEFINE FIELD IF NOT EXISTS userId ON source_connection TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope ON source_connection TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS createdAt ON source_connection TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON source_connection TYPE option<datetime> VALUE time::now();
DEFINE INDEX IF NOT EXISTS source_connection_status_idx ON source_connection FIELDS status;
DEFINE INDEX IF NOT EXISTS source_connection_pack_idx ON source_connection FIELDS packId;
DEFINE INDEX IF NOT EXISTS source_connection_user_idx ON source_connection FIELDS userId;

-- ── source_item ──────────────────────────────────────────────────────────
DEFINE TABLE IF NOT EXISTS source_item SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS connectionId ON source_item TYPE record<source_connection>;
-- The connector's own stable id for the item (file id, message id, path…).
DEFINE FIELD IF NOT EXISTS externalId ON source_item TYPE string;
DEFINE FIELD IF NOT EXISTS originUri ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS path ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS title ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS mediaType ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS size ON source_item TYPE option<int>;
-- The source's own revision (etag, revisionId, mtime+size, commit) as last
-- enumerated; `fetchedRevision` is the one the stored content came from.
-- The two differing = changed since fetch.
DEFINE FIELD IF NOT EXISTS revision ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS fetchedRevision ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS modifiedAt ON source_item TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS byteHash ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS contentHash ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS assetId ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS documentId ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS episodeId ON source_item TYPE option<string>;
-- ACL snapshot for org connections (G6 steps 3–5 consume it).
DEFINE FIELD IF NOT EXISTS acl ON source_item TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS state ON source_item TYPE string DEFAULT 'seen'
  ASSERT $value INSIDE ['seen', 'fetched', 'indexed', 'gone'];
DEFINE FIELD IF NOT EXISTS firstSeenAt ON source_item TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS lastSeenAt ON source_item TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS goneAt ON source_item TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lastError ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS userId ON source_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope ON source_item TYPE array<string> DEFAULT [];
DEFINE INDEX IF NOT EXISTS source_item_conn_ext_idx ON source_item FIELDS connectionId, externalId UNIQUE;
DEFINE INDEX IF NOT EXISTS source_item_conn_idx ON source_item FIELDS connectionId;
DEFINE INDEX IF NOT EXISTS source_item_state_idx ON source_item FIELDS state;
DEFINE INDEX IF NOT EXISTS source_item_user_idx ON source_item FIELDS userId;
