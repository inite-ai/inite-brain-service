# Importance/salience scoring — design note (V8 §4)

Status: DESIGN — no build before this note's confirm leg is agreed.
Context: Exabase M-1 (BEAM-100K 76.9) credits "temporal salience,
importance scoring, cross-memory coherence" as retrieval-scoring
signals. Our scoring has recency (read-decay), trust
(fact_trust/corroboration), interval overlap (temporalMode) and lane
arbitration; **importance is absent** — a fact about the user's career
change and a fact about one rainy afternoon carry the same prior.

## The signal

`salience`: a 0-3 integer per derived proposition, judged at derive
time.

| value | semantics | expected mass |
|---|---|---|
| 0 | incidental detail (small talk, one-off logistics) | ~10% |
| 1 | routine fact — the neutral default | ~60% |
| 2 | notable: decisions, changes, plans, recurring topics | ~25% |
| 3 | identity-central: job, family, health, home, long-term goals | ~5% |

## Written where

- `knowledge_fact.salience` (`option<int>`, new migration) — stamped by
  the **wd-v2 window deriver** on derived facts. The deriver already
  judges "durable vs ephemeral" per proposition; salience is one more
  field in its structured output (near-zero marginal tokens, no extra
  calls).
- Legacy / underived / live-ingest rows carry NONE; the read side
  treats NONE as 1 (neutral) — a soft migration with no recall cliff.
- The LIVE extraction path is deliberately **out of scope for v1**:
  derive-side only, so the signal lands in derived worlds first and is
  measurable on the eval axes without touching the online extractor.

## Read side

`scoreRows` folds a multiplicative factor:

    score *= SALIENCE_WEIGHTS[salience ?? 1]   // [0.8, 1.0, 1.1, 1.25]

- Weights are a tuning CONSTANT (segment-budget precedent), not a knob.
- Gated by a new boolean RetrievalProfile field `salienceScoring`
  (env `RETRIEVAL_SALIENCE_SCORING`, default off, per-tenant
  overridable — same class as `segmentRerank`/`entityExpansion`; the
  `RETRIEVAL_` prefix stays outside the golden flag budget's
  ENGINE_PREFIX by design).
- Interaction risk to watch: salience×recency double-counting — a
  salience-3 fact is usually also fresh at derive time. The A/B reads
  the temporal rows specifically for this.

## Measured how — the confirm legs (named, as required)

1. **Write parity leg** (cheap): re-derive ONE fresh LoCoMo tenant
   (dev-5, the w3d recipe) with salience-stamping in the deriver.
   Gate: proposition count bit-parity vs the unstamped derive; salience
   distribution sanity vs the expected-mass column above.
2. **Read A/B, LoCoMo axis** (the decision leg): same salience-stamped
   substrate, read-side pair `RETRIEVAL_SALIENCE_SCORING` off/on, full
   dev-5 QA. Verdict rule: overall non-negative AND no per-category row
   down >2pp; watch temporal rows for the recency interaction.
3. **BEAM axis** (conditional): only if (2) is non-negative — BEAM
   worlds need a paid re-derive to carry salience, so the BEAM full-400
   pair vs the v6agg-era control runs after the LoCoMo verdict, not in
   parallel.

## Explicit non-goals for v1

- No LLM re-scoring pass over existing facts (cost); salience arrives
  only with new derives.
- No decay-curve coupling (Exabase-style salience-modulated decay) —
  that is a v2 candidate only if the flat multiplier pays.
- No per-genre weight tables until a second genre shows a need.

## Build order (V8.5, after ack)

migration → deriver schema field + prompt line → `scoreRows` fold →
profile point + catalog + schema + gates → legs 1-2 → verdict → BEAM.
