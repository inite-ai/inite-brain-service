-- 0195_entity_core_types — people and organisations get types of their own,
-- and an entity keeps the type it was extracted with (maintainer-approved
-- data-model wave, 2026-11-13).
--
-- WHY. knowledge_entity.type was asserted (0001) to the CRM-era list
-- customer / staff / asset / project / topic / location / other. A general
-- memory knows people and organisations that are nobody's customer or
-- staff — a user's sister, their employer — and those were either forced
-- into a role the text never stated or folded into `other`, where the real
-- type was lost for good: nothing kept what the extractor had said.
--
-- WHAT CHANGES.
--  - type: the ASSERT widens to the list in src/common/entity-types.ts, the
--    one source of truth: + person, organization (people and organisations
--    without a business role) and document (a named document / file / page
--    as a subject — the file-memory, web-memory and legal packs declare
--    predicates about one). customer and staff keep meaning a client of the
--    business and someone who works for it; CRM connectors and packs keep
--    filing people under them. Widening only: every row already written
--    still passes, and an image still on the old list never writes a new
--    value, so the rolling deploy and a rollback are both safe.
--  - typeRaw: the type as extracted, kept whenever the normalised type
--    differs from it ("vendor" → other, typeRaw "vendor"). Written by the
--    upsert path when an entity is created. NO BACKFILL: rows written
--    before this migration never recorded what was folded, so there is
--    nothing to recover; NONE means "the type is what was extracted, or it
--    predates 0195".
--
-- Idempotent: OVERWRITE restates the field; IF NOT EXISTS adds the new one.

DEFINE FIELD OVERWRITE type ON knowledge_entity TYPE string
  ASSERT $value INSIDE ['customer', 'staff', 'person', 'organization', 'asset', 'project', 'document', 'topic', 'location', 'other'];
DEFINE FIELD IF NOT EXISTS typeRaw ON knowledge_entity TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 64;
