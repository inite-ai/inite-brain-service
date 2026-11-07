-- 0186_claim_assertion — a predicate may declare that every value it
-- holds is a guess put to the person or one they confirmed (#909 step 2).
--
-- WHY. GDPR gives a person rights over inferences about them (access,
-- rectification, objection) distinct from what they said, and an
-- inference revealing health is special category however tentative it
-- is (CJEU C-184/20). Export, contest and erasure (#909 step 3) need to
-- tell a claim's origin; until now it lived only in predicate names
-- (`stated_affect` vs `hypothesis`) and recorder constants.
--
-- HOW. A claim's assertion is one rule (src/common/assertion.ts,
-- assertionOf): the writer's stamp in the FLEXIBLE `source`
-- (`source.assertion = 'inferred'` + `source.inferredBy` from the
-- writers that conclude rather than record), else this predicate-level
-- declaration, else `stated`. No fact is rewritten: nothing before this
-- release was stamped, and a row with no stamp is read by the same rule.
--
-- Idempotent: IF NOT EXISTS.

DEFINE FIELD IF NOT EXISTS assertion ON knowledge_predicate TYPE option<string>
  ASSERT $value = NONE OR $value IN ['hypothesis', 'confirmed'];
