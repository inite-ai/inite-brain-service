-- 0182: when an edge was judged against memory (#834).
--
-- WHY. An edge closed only when the extractor named its handle in a fact's
-- `supersedes`. Facts get valid-time succession at write time (0177) and
-- fact resolution afterwards (#828), but edges had neither, so a relation a
-- conversation replaced stayed open beside its successor: `sasha lives_in
-- Lisbon` next to `sasha lives_in Porto`, `Diego leads sasha` next to
-- `Marta leads sasha`, both listed in every search.
--
-- Fact resolution now judges each new open edge against the open edges
-- that share an endpoint with it (src/dreams/edge-resolution.ts), and a
-- `replaces` closes the earlier one at the later one's validFrom. This
-- column says the edge has been judged; NONE means not yet.
--
-- BACKFILL. An edge already closed on either axis has nothing to judge and
-- is marked checked here. Open edges keep NONE and are worked through once,
-- in the bounded runs that already work through facts.
--
-- The index serves the pending scan (WHERE resolutionCheckedAt IS NONE).
-- Additive and idempotent: a re-run finds no closed edge left unmarked.

DEFINE FIELD IF NOT EXISTS resolutionCheckedAt ON knowledge_edge TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS edge_resolution_checked_idx ON knowledge_edge FIELDS resolutionCheckedAt;

UPDATE knowledge_edge SET resolutionCheckedAt = time::now()
WHERE resolutionCheckedAt IS NONE
  AND (validUntil IS NOT NONE OR invalidatedAt IS NOT NONE);
