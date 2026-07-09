-- 0052_retracted_by_dreams — allow retractedBy='dreams'.
--
-- DreamsResolverService.markSuperseded (src/dreams/resolver.service.ts)
-- closes the losing side of an aged competing pair with retractedBy='dreams'
-- so operators can tell nightly LLM adjudication apart from ingest-time
-- supersession ('system') and human retraction ('human'). The field ASSERT,
-- however, was never widened past the 0001 baseline
-- (['human','system','cascade']), so the first dreams-resolve UPDATE fails
-- the schema assert the moment DREAMS_RESOLVE_ENABLED=1 is switched on.
-- Latent in every deploy so far because the flag ships off.
--
-- No data backfill: no row can currently hold the value (such writes failed).

DEFINE FIELD OVERWRITE retractedBy ON knowledge_fact TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['human','system','cascade','dreams'];
