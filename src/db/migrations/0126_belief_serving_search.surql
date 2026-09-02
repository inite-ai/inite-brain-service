-- 0126: belief serving search — the lexical + (future) dense legs of the
-- synthesize-side belief lane (BELIEFS_SERVING_LANE, default off).
--
-- WHY. 0120 shipped semantic_belief as a shadow substrate: single-field
-- exact indexes only (userId/subject/status), no FULLTEXT, no embedding —
-- nothing on the serving path read it. The belief lane retrieves by
-- QUERY TEXT against the rendered statement (the deterministic template
-- embeds subject, field, value and prior value), so it needs exactly one
-- FULLTEXT index. Same lowercase-only analyzer contract as episode_text
-- (0073) / segment_text (0075) / scene_gist (0106) / fragment_content
-- (0124): snowball would mangle non-Latin scripts.
--
-- embedding is WRITE-DEAD by design (the 0124 precedent): no producer
-- fills it in this PR; the lane's dense leg is a brute cosine that
-- degrades to empty by construction until a promotion-side producer
-- exists. option<> keeps every existing row valid.
--
-- SINGLE-FIELD only, deliberately (the 0109/0111/0120 3.2.4 rule); every
-- deleter of this table already uses the LET $ids = (SELECT VALUE id …);
-- DELETE $ids; idiom and the audit-p1-guards spec pins the repo-wide
-- `DELETE semantic_belief WHERE` prohibition — this migration adds no
-- delete path. No changefeed, no event (0120 GDPR rationale stands).

DEFINE ANALYZER IF NOT EXISTS belief_statement TOKENIZERS class FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS belief_statement_search ON semantic_belief
  FIELDS statement FULLTEXT ANALYZER belief_statement BM25;

DEFINE FIELD IF NOT EXISTS embedding ON semantic_belief TYPE option<array<float>>;
