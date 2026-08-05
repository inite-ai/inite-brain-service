-- 0081: episode_segment.generation — rebuild provenance for the atomic
-- staging-swap (audit W2 #10/#11 carried work).
--
-- The composer used to delete-by-conversation, then spend the embedding
-- call, then insert — the segment lane read an EMPTY conversation for
-- the whole paid window, and a crashed run left it empty until the next
-- rebuild. The swap is now a single transaction (delete + insert), and
-- every row carries the run's generation stamp so a partially-failed
-- rebuild is observable: conversations still on the previous generation
-- are exactly the ones whose swap never landed.
--
-- generation is provenance, NOT a read filter — the atomic swap
-- guarantees at most one generation per conversation at any time, so
-- the segment lane stays version-blind by design.

DEFINE FIELD IF NOT EXISTS generation ON episode_segment TYPE option<string>;
