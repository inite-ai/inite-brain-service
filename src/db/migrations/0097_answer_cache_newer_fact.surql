-- 0097: widen answer_cache.invalidationCause with 'newer_fact' — the
-- additive-write freshness cause (audit F1, docs/roadmap/
-- measurable-economics-mri-2026-08.md freshness dimension).
--
-- The 0091 check-on-read only re-validated the facts a cached answer
-- already CITED, so an ADDITIVE write — a NEW active fact on a cited
-- entity, with none of the cited facts touched — could not invalidate a
-- now-stale/incomplete answer (it lived until expiresAt). The read-side
-- freshness probe (answer-cache.service.ts checkOnRead) now also looks
-- for any active fact on the cited answer's entities whose recordedAt is
-- newer than the answer's createdAt, under the SAME user-scope + row-
-- policy fences as the cited-fact re-check; a match stamps this cause and
-- falls through to a fresh synthesis. Fail-closed: a false probe hit
-- costs one cache miss, never a stale serve.
--
-- OVERWRITE (not a fresh field) so the ASSERT set gains 'newer_fact'
-- while every other column definition from 0091 is untouched.
DEFINE FIELD OVERWRITE invalidationCause ON answer_cache TYPE option<string>
  ASSERT $value = NONE
      OR $value INSIDE ['superseded', 'retracted', 'expired_validity', 'missing', 'newer_fact'];
