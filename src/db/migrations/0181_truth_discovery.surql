-- 0181: truth discovery — the posterior of a contested value, and how a
-- source's reliability was estimated (#847).
--
-- WHY. Two sources that disagree about one slot at the same valid time
-- stayed `competing` with nothing to say which is likely right, and the
-- learned source reliability was a win/loss tally that scored every
-- valid-time succession as a loss (a source that reports changes looked
-- unreliable). The nightly pass now fits Dawid–Skene over the contested
-- slots (src/ai/calibration/truth-discovery.ts): claim posteriors and
-- source accuracies together, one vote per origin, feedback as anchors.
--
--   * knowledge_fact.truth — on a fact whose value is contested at its
--     valid time: `posterior` that its value is the true one, `claims` in
--     the contest, `model` (the estimator's version) and `computedAt`.
--     Absent on every uncontested fact. Rewritten each night; cleared when
--     the contest is gone (resolution found `same` or `replaces`). A read
--     estimate, never a lifecycle input: nothing is superseded, retracted
--     or hidden because of it.
--   * source_trust.method — how the row was made: 'dawid_skene' from this
--     pass. Absent on rows the win/loss refit wrote; the first run
--     replaces those.
--
-- No event reads either field, and the answer cache validates citations
-- by status and validity only, so a nightly rewrite of `truth` neither
-- invalidates cached answers nor marks derived rows stale.
--
-- GDPR. `truth` lives on the fact row and goes with it. source_trust is
-- keyed by sourceKey (vertical:recorder), not by user, as before.
--
-- ROLLING DEPLOY. Additive, every statement IF NOT EXISTS; an image that
-- does not know the fields never writes them.

DEFINE FIELD IF NOT EXISTS truth ON knowledge_fact TYPE option<object>;
DEFINE FIELD IF NOT EXISTS truth.posterior ON knowledge_fact TYPE float
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD IF NOT EXISTS truth.claims ON knowledge_fact TYPE int;
DEFINE FIELD IF NOT EXISTS truth.model ON knowledge_fact TYPE string;
DEFINE FIELD IF NOT EXISTS truth.computedAt ON knowledge_fact TYPE datetime;

DEFINE FIELD IF NOT EXISTS method ON source_trust TYPE option<string>;
