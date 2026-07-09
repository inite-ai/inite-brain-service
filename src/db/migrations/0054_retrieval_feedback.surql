-- 0054_retrieval_feedback — the retrieval feedback loop, storage side.
--
-- DecisionLog explains what search picked and why, but nothing flowed
-- BACK: a consumer that saw a wrong or stale fact had only the blunt
-- instruments (retract, or nothing). This table records per-fact
-- verdicts from consumers ('helpful' | 'not_helpful' | 'incorrect');
-- the nightly source-trust refit folds them into the learned
-- agreementRate (helpful = win, incorrect = loss — the same currency as
-- supersede/corroboration outcomes), which moves ranking through the
-- already-shipped SEARCH_TRUST_BETA multiplier.
--
-- Anti-farming: UNIQUE (factId, actor) — one standing vote per caller
-- key per fact; repeat feedback replaces the verdict instead of
-- stacking. actor = the caller's key hash, never free-form.
-- 'not_helpful' is stored (relevance signal for future ranking work)
-- but does NOT move source trust — an irrelevant retrieval says nothing
-- about the source's reliability.

DEFINE TABLE IF NOT EXISTS retrieval_feedback SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS factId    ON retrieval_feedback TYPE record<knowledge_fact>;
DEFINE FIELD IF NOT EXISTS verdict   ON retrieval_feedback TYPE string
  ASSERT $value INSIDE ['helpful','not_helpful','incorrect'];
DEFINE FIELD IF NOT EXISTS reason    ON retrieval_feedback TYPE option<string>;
DEFINE FIELD IF NOT EXISTS actor     ON retrieval_feedback TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON retrieval_feedback TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS retrieval_feedback_fact_idx  ON retrieval_feedback FIELDS factId;
DEFINE INDEX IF NOT EXISTS retrieval_feedback_actor_idx ON retrieval_feedback FIELDS factId, actor UNIQUE;
