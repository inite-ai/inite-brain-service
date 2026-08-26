-- 0111_tool_observation — content-free tool→evidence anchors (Brain v2.1 P3).
--
-- WHY: tool results become evidence anchors BEFORE interpretation. Today a
-- tool call (MCP tool, pack-declared external tool) leaves no durable trace
-- an ingested document or derived fact can point back to: the provenance
-- chain starts at the document, and "which tool produced this" is folklore.
-- tool_observation is the missing hop — one append-only row per tool call
-- (what ran, digests of what went in/out, whether it succeeded, how long it
-- took), which the document ingest path can reference (toolObservationRef)
-- so a committed fact's source.evidence[] carries BOTH hops:
--   document → tool_observation.
-- This is an EVIDENCE surface, not an advice surface: it never touches the
-- strategy tables (strategy_item / strategy_trajectory) — only the digest
-- IDIOM is shared (src/common/payload-digest.ts, extracted from the
-- trajectory digester).
--
-- The 0107 content-free contract carries over verbatim:
-- meta is CONTENT-FREE by contract: record ids / verdict strings only,
-- NEVER fact text. That is what lets the GDPR entity-forget bulk-purge
-- run OUTSIDE the atomic erase transaction (an aborted erase merely
-- deleted telemetry early) and keeps these tables out of the PII
-- reconstruction surface.
-- Here the contract extends to the payloads themselves: args/results are
-- the most likely place for secrets or PII, so the row stores 16-hex
-- SHA-256 digest prefixes (argsDigest/resultDigest), never the payloads.
-- contentExcerpt is the ONE deliberate exception: a sanitized, ≤512-char
-- excerpt written ONLY when the operator opts in via
-- TOOL_OBSERVATION_CONTENT (default off) — off means the column is never
-- written and the table stays out of the PII reconstruction surface.
--
-- NO CHANGEFEED and NO DEFINE EVENT — deliberately. Mirroring per-call
-- telemetry into audit_event would flood the audit trail (the 0053/0107
-- rationale), and a DEFINE EVENT on a high-volume append table is a write
-- amplifier.
--
-- Growth bounds: rows ≤ tool-call volume × TOOL_OBSERVATION_RETENTION_DAYS
-- (default 30) — the nightly 03:41 UTC prune cron (OutcomePruneService)
-- deletes older rows in bounded batches; the recorder caps every stored
-- field and is fire-and-forget (an observation failure never fails the
-- tool call).
--
-- Indexes are SINGLE-FIELD only — the 3.2.4 planner rule: compound
-- WHERE shapes over this table are not on any serving path, and the
-- DELETE-WHERE planner no-op class (audit-p1-guards) is avoided by the
-- prune's SELECT-ids → DELETE subquery shape.

DEFINE TABLE IF NOT EXISTS tool_observation SCHEMAFULL;

-- Tool NAME is a function identifier (not sensitive) — clear text,
-- sanitized + length-capped by the recorder.
DEFINE FIELD IF NOT EXISTS tool           ON tool_observation TYPE string;
-- One-way SHA-256 prefixes over canonical JSON (payload-digest idiom):
-- identify a payload (dedup/provenance) without revealing it.
DEFINE FIELD IF NOT EXISTS argsDigest     ON tool_observation TYPE string;
DEFINE FIELD IF NOT EXISTS resultDigest   ON tool_observation TYPE string;
DEFINE FIELD IF NOT EXISTS ok             ON tool_observation TYPE bool;
DEFINE FIELD IF NOT EXISTS durationMs     ON tool_observation TYPE int;
DEFINE FIELD IF NOT EXISTS requestId      ON tool_observation TYPE option<string>;
-- Pack identity for external pack-tool calls (the generic wrapper cannot
-- know these; the proxy stamps them).
DEFINE FIELD IF NOT EXISTS packId         ON tool_observation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS installId      ON tool_observation TYPE option<string>;
-- Opt-in ONLY (TOOL_OBSERVATION_CONTENT): sanitized excerpt, ≤512 chars.
DEFINE FIELD IF NOT EXISTS contentExcerpt ON tool_observation TYPE option<string>;
-- CONTENT-FREE by contract (see header): ids / verdict strings only.
DEFINE FIELD IF NOT EXISTS meta           ON tool_observation TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS createdAt      ON tool_observation TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS tool_observation_created_idx ON tool_observation FIELDS createdAt;
DEFINE INDEX IF NOT EXISTS tool_observation_tool_idx    ON tool_observation FIELDS tool;
DEFINE INDEX IF NOT EXISTS tool_observation_request_idx ON tool_observation FIELDS requestId;
