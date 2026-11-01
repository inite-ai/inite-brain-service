-- 0178: an edge knows which documents still assert it (#830).
--
-- A document-born edge kept one `source.documentId`, the first document
-- that stated it; a second document stating the same relation landed on
-- the same row (UNIQUE in, out, kind, scopeKey) and left no trace. So when
-- a source item went away, or a record's next revision dropped a relation,
-- nothing could tell whether another live document still said it, and the
-- edge stayed open forever. Facts never had this gap: every restatement is
-- its own corroborating row.
--
--   source.documentIds  the documents that assert the edge and are still
--                       live. A restatement adds its document; a gone item
--                       or a revision that no longer makes the claim
--                       removes it. Empty means nothing grounds the edge
--                       any more, and it closes (`validUntil`), as a
--                       deleted file's facts do: history, not a lie.
--   source.undocumented set when the relation was also stated outside any
--                       document (a conversation turn). Document lifecycle
--                       never closes such an edge.
--   source.retiredAt    the instant the document lifecycle closed it, so a
--                       restatement or a returning item reopens exactly
--                       those closes and nothing else.
--
-- Backfill seeds the set with the one document every existing edge knows,
-- BEFORE the index exists (3.2.4: UPDATE … WHERE over an indexed field is a
-- silent no-op). The index is on the elements (`.*`): `CONTAINS $doc`
-- plans an IndexScan; `CONTAINSANY` and `IN` do not, so readers ask one
-- document at a time.

UPDATE knowledge_edge SET source.documentIds = [source.documentId]
    WHERE source.documentId IS NOT NONE AND source.documentIds IS NONE;

DEFINE INDEX IF NOT EXISTS edge_source_documents_idx ON knowledge_edge FIELDS source.documentIds.*;
