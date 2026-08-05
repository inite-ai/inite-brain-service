# Next session — V5: capability points to verdicts + the write tract (2026-08)

Context: V4 closed the read-path carry-list and measured all four new
profile points same-day (docs/roadmap/validate-2026-08-results.md,
§ "V4 confirm legs"). W4 is now essentially DONE; per the architecture
audit, SOTA-parity = W3 + W4 — so the biggest structural remainder is
the WRITE tract. The read-side measurements left three points one leg
away from a verdict.

Ordered by value. Each block is self-contained; cut from the bottom.

## 0. Gate: architecture manifest review (owner decision)

`docs/architecture-manifest.md` is a DRAFT awaiting owner review —
approve / edit / reframe. It shipped in PR #244 without an explicit
go-ahead on content. The V4 legs added its strongest evidence yet (the
'fused' genre split measured in both directions on the same day the
thesis predicted it) — worth folding into the evidence section on
approval.

## 1. Record attempt: 'fused' on LoCoMo HELD-OUT (paid, ~1 evening)

Why: dev-5 fused = 78.2% vs always 76.8% (+1.4pp, single-hop +2.6 at
p=0.08) AND cheaper (5550 vs 5745 avg prompt tokens). The standing
held-out record is E16 78.7%. If fused's dev-5 edge transfers, this is
a record attempt — and the first V4 capability point to earn a
default (the diary profile's).

Protocol:
- Fresh tenant (new BRAIN_API_KEYS entry — mint freely, see crib),
  full ingest of the HELD-OUT 5 conversations (E16's split — see
  docs/locomo.md for the split convention), diary WRITE profile, then
  derive wd-v2 + segments.
- ⚠️ THE WRITE PROFILE MUST BE VERIFIED against
  src/admin/config-catalog.data.ts before launching — the V2 session
  lost a leg to a brief that said "no other pins". The four required
  write-side pins are the dialogue extractor profile, event-time
  extraction, the episode substrate, and the caption knob; resolve
  their EXACT key names from the catalog, do not trust any list from
  memory (one of them was mis-remembered as OCCURRED_ON last time).
- Two read arms on the same substrate (brain restart between):
  `RETRIEVAL_VERBATIM_EVIDENCE=always` vs `=fused`, both with
  `RETRIEVAL_DATE_ANCHORING=none`, `RETRIEVAL_DERIVED_VERSION=wd-v2`.
- Pair with scripts/eval-analysis/locomo-mcnemar.py; also compare the
  fused arm against E16's held-out report (cross-substrate, nominal
  only).
- Verdict rule: fused becomes the DIARY-profile default only on a
  non-negative paired result here; the assistant-chat default is not
  in question (see §3).

## 2. W3 — the write tract (main engineering block)

The audit's remaining structural write items (engine-architecture-
audit-2026-08.md, "Still open / W3"):

- **Coined-predicate canonicalization into an alias column.** The
  dialogue tract lands coined predicates raw → policyFor falls back to
  bitemporal, dedup/corroboration key on (entity, predicate) and never
  fire across coinages. Design: keep the raw coined predicate, add a
  canonical alias column (migration 0082+) filled at write time by the
  existing EDC canonicalization the prompt already promises
  (prompts.ts vs extractor-refine.service.ts — the promise/skip gap is
  audit finding #2); read-side consumers (dedup keys, diversity caps,
  chatter demotion) switch to `alias ?? predicate`.
- **append_only default for open predicates.** Unknown (coined)
  predicates currently inherit the bitemporal default — supersede
  semantics invented for closed CRM predicates. Open-vocabulary
  observations should default to append_only; closed-vocabulary seeds
  keep their per-predicate policies.
- Both are WRITE-path changes: they need a FRESH derivedVersion /
  fresh-tenant paired confirm (LoCoMo dev-5 re-ingest vs the
  var/locomo-v4always-dev5.json baseline) before any default claim —
  the ewave rule: worlds built under different write behavior must
  not share a version.
- While in the area, close audit #4's cheapest slice if it falls out
  naturally (object-shape discipline / per-tract similarity
  thresholds) — do NOT force it.

## 3. Cheap read-side follow-ups (each ≤ an hour of wall-clock)

- **Segment token cap for 'fused' on assistant chats**: SSA showed
  −7.1pp n.s. at 2.3× prompt (4.9k→11.1k tok) — the fused leg pushes
  whole 4-turn windows into the prompt. Add a cap (truncate the
  segment object entering the prompt path, or a fact-centric
  per-segment budget — prefer a tuning constant over a new env knob),
  then re-run the SSA A/B (worlds survive on loco-321; arms are
  read-side). Verdict rule: fused must reach cost-parity before it is
  even a candidate outside the diary profile.
- **overlap_boost on BEAM temporal**: the temporal claim needs a
  second genre. BEAM-100K substrate survives on the stand (verify —
  the B0-era tenants); re-QA the full 400 (or the 5-conversation spot)
  with `RETRIEVAL_TEMPORAL_MODE=overlap_boost` vs a defaults control,
  pair with beam-mcnemar.py, read the temporal ability row (n=40).
- **entityExpansion on its target genre**: LME multi-session worlds
  are GONE (0/133 on the stand) — this needs a paid re-ingest of an
  MS subset (~40-60 worlds is enough for a paired signal; MS blocks
  are dataset indices 70-131 + 162-232). Ingest once, keep the worlds
  (they enable future MS legs), A/B control vs
  `RETRIEVAL_ENTITY_EXPANSION=1`.

## 4. Small engineering (fits between legs)

- **AbortSignal into the synthesize lanes**: request-context already
  carries getAbortSignal(); thread it into the lane/probe calls so an
  aborted request cancels in-flight lane I/O (the honest remainder of
  the RxJS discussion — structured cancellation, no new paradigm).
- **Dependabot sweep**: GitHub reports 17 high / 16 moderate on main —
  triage per the security-sweep idioms (approve+squash chore PRs,
  scoped overrides, --ignore-workspace for the lock).

## Stand crib (V4-verified mechanics — saves an hour of rediscovery)

- Stand: `docker start loco-321` (OOM-recidivist, exit 137 is normal;
  rocksdb intact), SurrealDB at ws://localhost:18321, root/root,
  NS brain, DB = `co_<companyId>`.
- Datasets: /tmp/longmemeval_s.json and /tmp/locomo10.json may be
  reaped — re-fetch per docs/locomo.md; LME index blocks: SSU 0-69,
  MS 70-131+162-232, SSP 132-161, TR 233-365, KU 366-443, SSA 444-499.
- ⚠️ run-longmemeval applies --types AFTER the --samples slice — for a
  typed block pass `--sample-offset <block start>`, not --types.
- Leg brains: launch `node dist/main.js` with an env file sourced on
  top of the shell (`set -a; source envfile; set +a`) — PORT and
  SURREALDB_URL MUST be process-env (Nest reads .env at lower
  precedence; .env's ws://localhost:8000 is a dead endpoint). Mint
  BRAIN_API_KEYS freely (sha256 of any key value);
  BRAIN_TENANT_OVERRIDE_ENABLED=1 requires brain:admin scope on the
  key; per-question LME tenants ride the x-brain-tenant header, the
  LoCoMo runner uses the key's own companyId.
- Driver pattern (health gate + auth smoke + kill-leftover-port +
  runner + kill): the V4 session's leg-driver.sh — reproduce from
  validate-2026-08-results.md § V4 confirm legs if the job tmp is
  gone. Always pass --resume var/<leg>.ckpt.jsonl.
- Analysis: scripts/eval-analysis/locomo-mcnemar.py (dev-5 pairs),
  beam-mcnemar.py (LME/BEAM by questionId).
- Derive is now fail-loud (V4): a 502 from maintenance/derive means
  the world is hollow — fix upstream, resume; the driver refuses
  non-ok derives by itself.

## Definition of done

- §1 verdict recorded (fused diary default: yes/no) + report in var/.
- §2 merged behind a fresh-derivedVersion confirm, or explicitly
  descoped with the reason in the results doc.
- Every leg's report carries provenance and lands in
  validate-2026-08-results.md (or a new v5 results doc if it grows).
- Memory + MEMORY.md updated; no eval forks — new behavior enters as
  profile points only (the gates enforce this).
