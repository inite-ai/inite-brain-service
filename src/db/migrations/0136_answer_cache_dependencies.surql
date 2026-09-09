-- 0136: answer_cache carries EVERY dependency of a cached answer, not
-- only its cited facts (audit 2026-09-06 F3).
--
-- 0091's admission stored the answer text plus `citedFactIds`, and the
-- check-on-read revalidated exactly those. A mixed answer — one fact plus
-- a belief / episode / fragment / scene citation — was admitted with the
-- non-fact half of its grounding silently dropped, so a belief revision
-- (the value the answer states is no longer the current state) left the
-- cached text serving until TTL: the cited fact still validated, and
-- nothing else was checked.
--
-- `dependencies` records the non-fact evidence arms as typed entries
-- {kind, id, rev}: `rev` is the lifecycle stamp observed at admission (a
-- belief's `revision`, a scene's gist hash, a fragment's asset quarantine
-- state; an episode is immutable text, so existence is its lifecycle)
-- and the read path fails closed on a missing row, a dead lifecycle
-- state, or a changed stamp. Pre-0136 rows carry no `dependencies` and
-- are treated as unverifiable (invalidated on their next read); the
-- cache-key version bump in answer-cache.service.ts makes them miss by
-- key construction anyway.
--
-- `dependency_changed` joins the invalidation causes: the stamp moved
-- while the row stayed in a servable state (a belief revised in place, a
-- scene recomposed, an asset's quarantine state changed).
DEFINE FIELD IF NOT EXISTS dependencies ON answer_cache TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS dependencies.* ON answer_cache TYPE object;
DEFINE FIELD IF NOT EXISTS dependencies.*.kind ON answer_cache TYPE string
  ASSERT $value INSIDE ['belief', 'episode', 'fragment', 'scene'];
DEFINE FIELD IF NOT EXISTS dependencies.*.id ON answer_cache TYPE string;
DEFINE FIELD IF NOT EXISTS dependencies.*.rev ON answer_cache TYPE string;
DEFINE FIELD OVERWRITE invalidationCause ON answer_cache TYPE option<string>
  ASSERT $value = NONE
      OR $value INSIDE ['superseded', 'retracted', 'expired_validity', 'missing', 'newer_fact', 'dependency_changed'];
