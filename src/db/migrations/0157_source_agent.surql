-- 0157_source_agent — the local agents a tenant has heard from
-- (docs/source-plane.md § The local agent). One row per agent id: when
-- it last checked in, what it runs, and the folders it can see — the
-- inventory the admin's folder picker browses for an agent-host
-- connection, since the brain cannot list a laptop's disk itself.
-- Additive; option-typed; no data migration.
DEFINE TABLE IF NOT EXISTS source_agent SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS agentId ON source_agent TYPE string;
DEFINE FIELD IF NOT EXISTS lastSeenAt ON source_agent TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS firstSeenAt ON source_agent TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS version ON source_agent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS hostname ON source_agent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS platform ON source_agent TYPE option<string>;
-- { roots: [{ path, folders: [relative dir paths, bounded] }] } — what the agent reported.
DEFINE FIELD IF NOT EXISTS inventory ON source_agent TYPE option<object> FLEXIBLE;
DEFINE INDEX IF NOT EXISTS source_agent_id_idx ON source_agent FIELDS agentId UNIQUE;
