-- 0151_merge_log_known_kind — widen entity_merge_log.matchKind with the
-- extractor's own pin.
--
-- WHY. The extractor now reads the memory around a turn (the known
-- entities of the conversation) and pins a mention to one of them by
-- handle — "Ana" after "Ana Costa", a transliteration, a role the
-- conversation tied to a person. The upsert ladder files the mention
-- under that entity without a scan or a judge, and audits the reuse like
-- every other deterministic reuse. The reversible-resolution log (0102,
-- widened in 0150) asserts the kinds it knows; without this row the audit
-- of a pinned reuse is refused and silently missing (recordMerge never
-- throws). Same field, same type; the enum is the only change.
DEFINE FIELD OVERWRITE matchKind ON entity_merge_log TYPE string
    ASSERT $value IN ['exact', 'externalRef', 'translit', 'embedding', 'article-variant', 'name-part', 'known'];
