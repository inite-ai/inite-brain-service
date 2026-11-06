-- 0185_affect_health_classes — sensitivity classes for feelings and
-- health, and a class on beliefs (#909 step 1).
--
-- WHY. A predicate's piiClass was a label: only an explicit
-- `requiresScope` fenced a read, and the one predicate list the DB knows
-- (0005/0057: address, dob) does not grow with packs. The relationship
-- pack classed `stated_affect` and the hypothesis predicates `sensitive`
-- and set no scope, so any brain:read caller read how a person said they
-- feel. From this release the class is the fence: `sensitive`, `affect`
-- and `health` need brain:read_pii, one rule applied wherever a
-- predicate definition is built (classRequiredScope,
-- src/ai/predicate-registry-internals/types.ts) — the JS row filter is
-- the enforcing layer (the 0005 field gates are inert for system users,
-- see 0057's FINDING).
--
-- `affect`: how a person feels — what they say, guesses put to them, and
-- (#909 step 4) emotion inferred from their words. `health`: GDPR art. 9
-- / LGPD art. 11 special category. An inference that reveals either is
-- that class however tentative it is (CJEU C-184/20).
--
-- semantic_belief gains the same column. NONE = unclassed (the scene
-- promoter's rows until it classifies them); a writer of affect beliefs
-- stamps `affect`, and the belief read surface fences by it.
--
-- Idempotent: OVERWRITE redefines the ASSERT in place; no data change —
-- every existing value stays inside the widened set.

DEFINE FIELD OVERWRITE piiClass ON knowledge_predicate TYPE string
  ASSERT $value IN ['none', 'identifier', 'behavioral', 'text', 'sensitive', 'affect', 'health'];

DEFINE FIELD IF NOT EXISTS piiClass ON semantic_belief TYPE option<string>
  ASSERT $value = NONE OR $value IN ['none', 'identifier', 'behavioral', 'text', 'sensitive', 'affect', 'health'];
