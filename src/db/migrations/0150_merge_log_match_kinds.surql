-- 0150_merge_log_match_kinds — widen entity_merge_log.matchKind with the
-- two candidate sources the resolver grew after 0102 wrote the enum.
--
-- WHY. The reversible-resolution log (0102) asserts matchKind to the four
-- scans that existed then. Two more have since named candidates:
--   'article-variant' — the article-insensitive reuse in entity-upsert
--                        (INGEST_ARTICLE_NORMALIZATION);
--   'name-part'       — a key that is a whole token of an existing key,
--                        the first-name-after-full-name case ("Артём"
--                        three turns after "Артём Соколов"), decided by
--                        the judge with the part named as the reason.
-- With MULTILINGUAL_ENTITY_REVERSIBLE on, a reuse through either scan was
-- refused by this assert and the audit row silently missing (recordMerge
-- never throws). Same field, same type; the enum is the only change.
DEFINE FIELD OVERWRITE matchKind ON entity_merge_log TYPE string
    ASSERT $value IN ['exact', 'externalRef', 'translit', 'embedding', 'article-variant', 'name-part'];
