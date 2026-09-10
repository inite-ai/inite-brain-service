-- 0143: finish retiring knowledge_fact.altEmbedding.
--
-- 0139 issued `REMOVE FIELD altEmbedding`, which on SurrealDB 3.2.4 removes
-- only the column's own definition: the `altEmbedding.*` element definition
-- the server generated for the `array<float>` type stays behind, and while it
-- does a SCHEMAFULL write of `altEmbedding = [...]` is still accepted and
-- stored (measured on v3.2.4). A retired column has to reject writes, not
-- merely drop out of INFO FOR TABLE, so the element definition goes too
-- (test/segment-hnsw.e2e-spec.ts asserts the rejection).
--
-- The UNSET pass comes FIRST and is not optional: once no definition covers
-- the field, a row that still HOLDS a value cannot be written at all — every
-- UPDATE of it fails with "Found field 'altEmbedding', but no such field
-- exists" (measured). The column's writer was reverted long before 0139, so
-- this is a no-op on every current deployment and a repair on any tenant that
-- ingested while SEARCH_HYPE_ENABLED was on.
UPDATE knowledge_fact UNSET altEmbedding WHERE altEmbedding != NONE;
REMOVE FIELD IF EXISTS altEmbedding.* ON knowledge_fact;
