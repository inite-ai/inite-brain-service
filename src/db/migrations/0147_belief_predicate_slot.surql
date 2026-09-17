-- 0147: give the belief plane the SAME slot identity as the fact plane.
--
-- WHY. The two planes named attributes in two different languages and
-- could not be joined. Facts key on the registry's predicate id —
-- `(predicateAlias ?? predicate)`, the 0083 slot identity. Beliefs kept
-- the extractor's free text: `deployment target`, `job queue backend`,
-- `HTTP service port`. Measured on a live tenant: of 12 beliefs, ZERO
-- matched any of 163 distinct fact (subject, predicate) keys. Not
-- "rarely" — the BELIEFS_FACT_DAMPING pass joins those keys by string
-- equality, so it was structurally incapable of firing, and it reported
-- exactly that: 69 clean, 0 damped.
--
-- The belief plane also fragmented the same way the predicate plane did,
-- and had its own second mechanism for it — a lexical token-subset rule
-- over a hand-written six-word stoplist of "generic modifiers". Measured
-- against the same 12 live fields, that rule folded 0 pairs and missed
-- all three it existed to catch:
--
--   deployment target  ~ deployment platform   (AWS ECS Fargate vs Fly.io)
--   job queue backend  ~ queue backend         (Redis Streams vs NATS JetStream)
--   pilot launch date  ~ date
--
-- So the serving prompt's "current state" section carried both the stale
-- and the current value of the same attribute, presented as two settings.
--
-- WHAT THIS DOES. Two columns, named and shaped exactly as knowledge_fact
-- names them, so one vocabulary serves both planes:
--
--   predicateId    — the registry id this belief's field resolved to
--   predicateAlias — the canon, when consolidation later aliases it
--
-- The slot is `(predicateAlias ?? predicateId)` on both planes, so the
-- SAME PredicateConsolidationService pass that folds the fact vocabulary
-- folds the belief vocabulary with it, and the damping join becomes id
-- to id. The belief-side lexical rule is deleted rather than repaired:
-- one attribute-naming mechanism, not two.
--
-- `field` STAYS. It is the display name rendered into the prompt
-- ("deployment target = AWS ECS Fargate" reads better than
-- "deploy_target = ..."), and it is what the read API has always
-- returned. Identity moves to predicateId; presentation stays on field.
--
-- BACKFILL-FREE BY CONSTRUCTION. Both columns are option<string>, so
-- rows written before this migration keep NONE and simply do not
-- participate in the cross-plane join — the behaviour they have today.
-- The promoter fills them on the next write of that (user, subject,
-- field); nothing has to be rewritten in place.
--
-- 3.2.4 PLANNER DISCIPLINE (the 0093/0120 idiom): single-field indexes
-- only. A compound index over a field that a DELETE/UPDATE ... WHERE
-- then filters on is the silent-no-op class this schema avoids
-- everywhere.

DEFINE FIELD IF NOT EXISTS predicateId ON semantic_belief TYPE option<string>;
DEFINE FIELD IF NOT EXISTS predicateAlias ON semantic_belief TYPE option<string>;

DEFINE INDEX IF NOT EXISTS belief_predicate_idx ON semantic_belief FIELDS predicateId;
DEFINE INDEX IF NOT EXISTS belief_predicate_alias_idx ON semantic_belief FIELDS predicateAlias;
