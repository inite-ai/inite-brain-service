-- 0176: rows read from a team-scoped source carry its `team:` tags.
--
-- An org connection writes a private repository's or channel's items
-- under its groups' `team:` tags (W5, write-scope.ts). The document and
-- its turns carried them; what was read from them did not:
--   - fn::resolve_fact creates a fact with no scope, and the follow-up
--     stamp only acted for a fact with a user — a fact with no user and a
--     team scope stayed [] (tenant-global);
--   - the commit of a document runs in a job, outside the source door's
--     ambient write scope;
--   - scenes (and segments, insights) inherited circle tags from their
--     member turns, not team tags.
-- Under SCOPE_TAGS_ENABLED a reader without the group could therefore
-- read the facts and scene gists of a source it cannot read. Writes are
-- fixed in code (stampFactScope, CommitWriterService, withSourceScope);
-- this backfills the rows already written. The AND-set only narrows: a
-- tag added here can hide a row from a reader, never show one.
--
-- Facts: a fact with no user whose source document carries team tags
-- gains them. A fact with a user keeps its personal scope (a personal
-- write is never widened or re-scoped by a source's groups). The cast
-- is guarded with IF: Surreal does not short-circuit AND, and
-- type::record(NONE) throws.

UPDATE knowledge_fact SET
    scope = array::union(
        scope ?? [],
        (IF source.documentId != NONE THEN type::record(source.documentId).scope ELSE [] END ?? []).filter(|$t| string::starts_with($t, 'team:'))
    )
WHERE userId IS NONE
  AND source.documentId != NONE
  AND array::len(
        (IF source.documentId != NONE THEN type::record(source.documentId).scope ELSE [] END ?? []).filter(|$t| string::starts_with($t, 'team:'))
      ) > 0;

-- Scenes: a scene gains every team tag its member turns carry
-- (`$parent` is the scene row inside the subquery).
UPDATE memory_episode SET
    scope = array::union(
        scope ?? [],
        array::distinct(array::flatten(
            (SELECT VALUE out.scope FROM memory_episode_member WHERE in = $parent.id)
        )).filter(|$t| $t != NONE AND string::starts_with($t, 'team:'))
    )
WHERE segmenterVersion != NONE
  AND array::len(
        array::distinct(array::flatten(
            (SELECT VALUE out.scope FROM memory_episode_member WHERE in = $parent.id)
        )).filter(|$t| $t != NONE AND string::starts_with($t, 'team:'))
      ) > 0;
