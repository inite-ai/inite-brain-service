-- 0088: stats views — incrementally-maintained count() rollups for the
-- tenant counter surfaces (first `AS SELECT` computed tables in the
-- schema).
--
-- Why: StatsService.overview (end-user Usage page) and the admin
-- dashboard fan-out (AdminService.collectTenant) re-run the same COUNT
-- aggregates over the largest tables on every page load. A computed
-- table makes SurrealDB maintain the counts on source writes instead:
-- the read becomes an O(#groups) row fetch, and write amplification is
-- one tiny rollup-row update per source mutation.
--
-- Why counts ONLY: SurrealDB's incremental view maintenance has known
-- upstream bugs for non-invertible aggregates (math::median /
-- math::stddev drift after deletes/updates because they cannot be
-- decremented exactly). count() is exactly invertible — +1 on create,
-- -1 on delete, group-move on update — so count rollups are the safe
-- class. Keep median/stddev-style rollups OUT of computed tables until
-- upstream fixes land.
--
-- 3.1.5 semantics: the initial materialization runs the full SELECT at
-- DEFINE time, so tenants that already hold data get correct counts the
-- moment this migration applies (tenant tables are moderate — this is a
-- one-off scan per tenant DB). After that the table updates
-- incrementally on every source write. SurrealDB 3.2 makes computed
-- tables read-only — we never write them, so that upgrade is a no-op
-- for these tables.
--
-- Read path: STATS_VIEWS_ENABLED (default off) gates the view reads in
-- StatsService / AdminService; flag off = the live GROUP queries,
-- byte-identical to pre-0088 behavior. Time-windowed counts (facts last
-- 7d, dead-letter/forgotten last 24h) stay live in BOTH paths — a
-- moving window cannot be a static view.

DEFINE TABLE IF NOT EXISTS stats_entity_total AS
  SELECT count() AS n FROM knowledge_entity GROUP ALL;

DEFINE TABLE IF NOT EXISTS stats_fact_by_status AS
  SELECT count() AS n, status FROM knowledge_fact GROUP BY status;

DEFINE TABLE IF NOT EXISTS stats_community_total AS
  SELECT count() AS n FROM community_node GROUP ALL;
