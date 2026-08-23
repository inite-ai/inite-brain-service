# SOTA gap build — closing what the field has and we don't (2026-08)

Companion to the [Spectron competitive analysis](spectron-analysis-2026-08.md)
and [memory research §2/§8-9](memory-research-2026-08.md). Scope: every
capability the 2026 SOTA field (Spectron, Mastra, ReasoningBank, semantic-cache
lineage, memory-security literature) has shipped or proven that brain lacks —
researched, designed against our code seams, and built behind default-off
flags. No paid eval spend (measurement program parked); correctness gates are
unit + e2e + goldens.

## Gap inventory

| # | Gap | Source of evidence | Status here |
|---|---|---|---|
| G1 | Response-reuse answer cache (Spectron T2) | Spectron ladder; GPTCache lineage; Krites verified caching | Not built |
| G2 | Confidence-gated escalation to raw context (L3 lane) | Spectron T4 (<0.40 → escalate); Mastra OM ladder; fovea §8 | Triggers exist, never escalate UP |
| G3 | Char-span provenance (`source.span`) | Spectron provenance invariants | Episode indices only, no offsets |
| G4 | Failure-distilled strategy memory | ReasoningBank (ICLR); Reflexion lineage | Not built |
| G5 | Memory-injection red-team suite | MINJA (>95% success vs published systems) | No adversarial memory tests |
| G6 | Hierarchical scope tags (OR-of-ANDs) | Spectron contexts/scope model | Flat userId, fail-closed |
| G7 | Sleep-time consolidation sweep | Letta sleep-time; our substrate-refresh +3.0 | Dreams infra exists, no idle sweep |
| G8 | Trace-derived ranking features (usage → ranking) | Spectron "eight signals" includes prior retrieval success/failure | `fact_usage.readCount` written-and-never-read; flags default off |
| G9 | Ingest-time prompt-injection scanning (defense, not just tests) | Spectron ships it on every tier; MINJA literature | None today |

Build order: G1+G3 (cheap, product-visible) → G2 (flagship cascade rung) →
G4+G5+G9 (new lane + security tests + defense) → G8 (usage wiring quick win)
→ G6 design doc → G7 folded into G4's job host.

Landing-page intel (pricing, waitlist status, byte-offset spans, upstreaming
intent) is recorded in [spectron-analysis §5](spectron-analysis-2026-08.md#5-landing-page-intel-surrealdbcomagent-memory-fetched-2026-08-22).

## G1 — Answer-reuse cache (fact-lifecycle-gated)

**Research verdict.** Semantic caches are production-standard (20-45% realistic
hit rates, 59-73% spend cuts in published cases) but similarity-keyed serving
is unsafe for a strict-accuracy platform: temporal/polarity query variants
("Q1 2024" vs "Q1 2025") routinely exceed 0.95 cosine and become silent wrong
answers. The 2026 pattern that survives strictness is layered: exact-match
serving tier + async-verified promotion of similarity candidates (Krites,
arXiv 2602.13165). Provenance-linked invalidation has one near-neighbor
(Coalent: "surgical provenance-keyed invalidation") but **nobody published
fact-status check-on-read gated by bitemporal validity windows — that
combination is ours to claim.** Poisoning literature (CacheAttack 86% hijack;
NDSS 2026 semantic-cache-poisoning) demands per-user partitioning + verified
admission.

**v1 design (agreed):**

- Table `answer_cache`: scope columns (companyId, userId), `queryHash` (unique
  per scope), queryText, answer, `citedFactIds`, `entityIds`, profile/flag
  hash, modelId, promptVersion, createdAt, expiresAt, hitCount, lastServedAt,
  invalidatedAt + cause.
- Key = SHA256 of `tenant|user|profileHash|model|promptVersion|normalized(query)`.
  **No embedding lookup in v1** — exact normalized match only; zero false-hit
  surface by construction.
- Admission: write-through from synthesize only when the citation verifier
  passed AND citedFactIds is non-empty. Never cache abstentions or
  zero-citation answers (uninvalidatable).
- Serving: hit → **check-on-read**: one batch SELECT of cited facts; serve
  only if every fact is still `active` and inside its valid window; any
  failure marks the entry invalidated (with cause) and falls through to fresh
  synthesize. Fail-closed: a lost event can't serve a dead fact because
  there are no events on the serving path.
- Hygiene: TTL backstop (default 24h) + eviction sweep on fact change
  (entity-overlap eviction behind its own flag — the "entity-aware" guard
  against *new* facts changing an answer whose old citations are all still
  active).
- Flags: `ANSWER_CACHE_ENABLED` (default off), TTL, entity-invalidation
  toggle. Per-tenant config, not an eval fork.
- Headline metric: check-on-read rejection rate by cause — it measures
  exactly how much staleness the fact link prevented.
- v2 (explicitly deferred): embedding-similarity candidates promoted to
  servable only after an async judge verification — never served unverified.

## G2 — L3 escalation lane (confidence-gated raw-context escalation)

**Research verdict.** The two escalation signals the literature validates
hardest are both already live in our stack and merely terminate wrong:
per-citation support verdicts (Self-RAG's ISSUP family — our judge-verifier)
and answerability self-assessment (Self-Route's "unanswerable" → route to
full context; 82% of queries stay cheap, cost −39–65%, accuracy within 2pp of
pure long-context). Today they end in abstain/re-search; the build is the
wiring UP a layer. Threshold practice: fixed global constants (Spectron's
0.40) are the weakest form — CRAG's tuned thresholds vary wildly per dataset
((0.59,−0.99) PopQA vs (0.95,−0.91) Biography); best practice is
quantile-calibrating to a **fire-rate budget** on dev splits, per retrieval
profile (our segment-lane genre law predicts thresholds won't transfer).
Sobering datum: full-context GPT-4o scores 60.2 on LongMemEval — a floor, not
a ceiling; Mastra OM beats it (94.87) with *compression quality and no
confidence gating at all*. Escalation is a complement to substrate quality,
sized by the residual: ablation mining says 67% of our misses have gold
already in facts (selection problem) — L3's addressable pool is the other
~33%.

**v1 design (agreed):**

- Trigger: (verifier-unsupported OR abstain-intent) AND coverage < floor;
  or search-loop refine already ran once without clearing the verifier.
  Never on low retrieval scores alone.
- Anchor requirement: ≥1 fact/episode hit must name a session; no anchor →
  abstain (empty-memory queries must not burn full-context calls).
- Session selection: rank by fact-hit density via episode_indices; lift top
  1–3 full session transcripts. Temporal-class questions select sessions by
  date-range overlap with the question window.
- Ordering: L1 → verifier fail → one refine → L2 windows → L3 full sessions
  → abstain only after L3. Monotone single-shot ladder (`escalated` flag,
  each tier at most once) — the loop-proof invariant.
- Bounds: hard token cap per call (start 60k), degrade to widened L2 windows
  when over cap; per-tenant daily L3 budget; per-user rate limits.
- Calibration: trigger-signal quantile hitting a 10–15% fire-rate budget on
  dev, verified held-out, per profile. No naked constants.
- Telemetry: per-query ladder trace (tier reached, trigger reason enum,
  signal values, tokens per tier, whether L3 flipped the verifier verdict).
  Spectron claims "traceable escalation"; ours is *verified* escalation.
  L3 flip rate is the canary — near-zero means the gate is miscalibrated.
- Flags: `RETRIEVAL_L3_ESCALATION` (default off), max-sessions, token cap —
  retrieval-profile fields, no eval forks.
- Risks held: cost blowup (fire-rate budget + caps), escalation loops
  (monotone invariant), gaming (anchor + rate limits), privacy (user-scope
  pin + PII fencing apply to session selection).

## G3 — Char-span provenance

**Research verdict.** The W3C Web Annotation model is the settled practice:
store a **triple** — `TextPositionSelector` (start/end char offsets) +
`TextQuoteSelector` (`exact` + ~32-char `prefix`/`suffix`) + a content
hash/version of the source text. Offsets give O(1) jump-to-quote; the quote
with context re-anchors when the source drifts; the hash says which text the
offsets were valid for. Offsets must be recorded in **Unicode code points
over NFC-normalized text** (never UTF-16 units or bytes without saying so —
Spectron stores byte offsets; we document our unit explicitly). Drift rule:
offsets are a hint, quote+context is truth — on hash mismatch, fuzzy
re-anchor (Hypothesis idiom); if re-anchoring fails, mark span `stale` and
show the stored quote verbatim, never a wrong highlight. Multiple matches →
disambiguate by context or flag all, never silently pick the first.

**v1 design (agreed):** deriver emits per-grounding-turn span objects
`{start, end, exact, prefix, suffix}` (code points, NFC); migration adds the
span payload to fact provenance; provenance API returns spans per grounding
turn with the episode content hash; spans optional (old facts stay
span-less), additive and backward-compatible.

## G4 — Failure-memory lane (ReasoningBank shape)

**Research verdict.** ReasoningBank (arXiv 2509.25140, Google) is the load-bearing
reference: distill ≤3 natural-language strategy items per judged trajectory
(successes → transferable strategies; failures → *preventative lessons*, never
replayable procedures — that framing is why failures help them (+3.2pp over
success-only) while procedure-storing baselines degrade). Retrieval k=1 is
validated and sharp: WebArena 49.7% at k=1 → 44.4% at k=4 — **more strategies
actively hurt**. Their weakest component is the LLM judge labeling
trajectories; we can delete it: our eval harness has ground-truth misses with
diagnosis codes. Lifecycle is their acknowledged gap — Memp
(deprecate-on-feedback) and ExpeL (vote counters) supply the missing pattern.
Universal field rule: procedural memory lives in a **separate store, separate
retrieval call, separate prompt section** — nobody mixes lanes.

**v1 design (agreed):**

- New table + lane `strategy_memory`, never unioned with fact lanes, excluded
  from grounding/provenance (advice, not evidence).
- Item: `{title, situation (question class/genre/temporal shape preconditions),
  strategy (2-5 sentences, why/when — not step scripts), polarity: do|avoid,
  evidence: {source, runIds, nSupport, nContradict, lastValidatedAt},
  scope: tenant|global, status: candidate|active|deprecated}`.
- Distillation source #1: eval-harness post-mortems (ground truth, no judge
  noise) clustered by diagnosis code, ≤3 items per cluster. Source #2 (later,
  flagged): production traces + temp-0 judge with write-confidence threshold.
- Retrieval: k=1 (2 only above a strict similarity floor), injected into the
  synthesis prompt as a fenced ADVISORY section with an explicit
  "assess applicability before use" instruction. Never into derive prompts.
- Lifecycle: candidate → active on confirmation; retrieval-outcome feedback
  updates vote counters; auto-deprecate on nContradict ≥ 2 or 90d
  unvalidated. Mem0-style dedup-merge at write (ADD/UPDATE/NOOP vs top-5
  neighbors) — no append-only growth.
- Flags: `STRATEGY_MEMORY_ENABLED` (lane, default off),
  `STRATEGY_RETRIEVAL_ENABLED` (read side, separately off).
- Tests: leakage test (zero strategy items in fact-lane results), k-cap test,
  golden items from known V12/V13 miss clusters.
- Success bar when measurement resumes: +2-4pp strict on miss-heavy splits at
  k=1, flat elsewhere; kill if flat-to-negative (effects are
  backbone-dependent).

## G5 — Memory-injection red-team suite (+ G9 defense)

**Research verdict.** MINJA (arXiv 2503.03704) is a query-only attack: an
ordinary user's crafted queries get their outputs/reasoning written into
memory as benign-looking records ("bridging steps" + a progressively
shortened indication prompt), which later fire on the victim's queries.
Injection success 95.6–100%, attack success avg 76.8% across published
agents. Its precondition — user interactions derived into persistent
retrievable beliefs — **is our core loop**; per-user fail-closed scoping
contains it to self-poisoning, which still matters for consequential actions
and becomes cross-user the moment share-up scoping (G6) exists. Document
candidates match PoisonedRAG (~90% ASR with 5 docs per question against a
million-doc store); external indexers match AgentPoison (>80% ASR at <0.1%
poison rate via trigger-optimized embedding clusters); MCP surfaces add
tool-description poisoning. Strongest-fit defenses we mostly already own:
provenance-gated influence (promote `fact_trust` from ranking signal to a
hard gate on belief write), staging quarantine (per-run staging exists —
extend the promotion gate), read-time attribution fail-closed (exists),
write-pattern anomaly detection (new: near-duplicate cluster-density alarm).

**v1 build (agreed):** 12-scenario red-team e2e suite — MINJA bridging
self-poison, cross-user leakage, PoisonedRAG doc candidates, AgentPoison
trigger cluster, MCP direct-write abuse, tool-description poisoning, sleeper
memory, ownership/retraction spoof, scope-escalation via share-up,
unattributable answer, EchoLeak-style persistence, contradiction flood —
each asserting the fail-closed expectation. Plus the G9 defense build:
ingest-time sanitization (spotlighting/data-marking of untrusted spans) and
the write-anomaly counter, behind flags.

## G6 — Hierarchical scope tags (design only this wave)

**Research verdict + agreed design.** Scope tags as an AND-set per record,
visibility as OR-of-ANDs (the Spectron shape, generalizing our single
`userId` = the one-clause `[user/<id>]`). Non-negotiables that keep it
fail-closed where Spectron isn't: no tag ⇒ **self-scope only** (narrowest,
never broadest); write-scope separated from read-scope; derive writes at the
narrowest scope of its inputs; **share-down free, share-up privileged**
(ABAC grant + staging before other users are influenced); Zanzibar-style
relation tuples for group membership; consistency tokens on scope/membership
changes (the new-enemy problem — critical in a bitemporal store where old
snapshots persist); per-tenant DB stays the hard outer boundary, tags never
cross it. Migration path is five no-op-until-used steps: scope column
backfilled to `[user/<id>]` → visibility evaluator behind a flag proving
parity with the userId filter → ABAC write/widen policies → share-up via
staging → revocation tokens. Failure modes to test: empty-tag records,
widening races, unresolvable tags (fail closed), nested-group cycles.

## Code seams (mapped 2026-08-22)

Load-bearing facts from the seam pass, recorded so build PRs don't re-derive
them:

- **Next migration: `0091_*.surql`.** House template = `0086_conversation_digest.surql`
  (SCHEMAFULL, `IF NOT EXISTS` everywhere, rationale header).
- **G1 cache key inputs exist post-verification** at
  `synthesize.service.ts:378-383` (`resolveCitations` → `citedSet`); the
  verdict matrix is `verdict.ts:37 finalizeVerdict`. There is **no
  profileHash concept** anywhere — the cache key must compose one (profile
  fields + model + prompt version); `ReadPin`/`derivedVersion` is the nearest
  primitive and must be part of the key (a derive flip must miss).
- **G2 needs one new read-port method**: `episode-read-store.service.ts` has
  bounded `windowAround` only — whole-session fetch is a new method behind
  the same `piiGate`/`userGate`. Token policy is centralized in
  `openai-client.ts chatCallParams` (do not hand-roll). New synthesize
  outcomes extend the `countSynthesize` union (`metrics.service.ts:458`).
  The search-loop one-round cap (`refineRound`, guard at
  `synthesize.service.ts:612`) is the precedent for the monotone ladder flag.
- **G3 needs NO migration**: `fact.source` is `TYPE object FLEXIBLE` — span
  payloads ride it (documented idiom). Two traps: (i) `captureTurn` runs
  `redactPiiWithReport` BEFORE storage, so spans must be computed against the
  *stored redacted* text, not the wire text; (ii) provenance API caps text at
  `PROVENANCE_TEXT_CHAR_CAP = 600` — span offsets must reference the
  untruncated episode text and say so. Char-span precedent exists write-side:
  `extractor-internals/grounding.ts` (`valueSpan`, `normalizeForGrounding`).
- **G4 verdict — separate table wins.** The seam pass priced both options:
  `source.kind='strategy'` on knowledge_fact is 3 edits, a separate table is
  a migration + read port + fences. The research's hard rule (nobody mixes
  lanes; leakage must be structural, not filter-discipline) decides it:
  **separate `strategy_memory` table**, new `LaneId` in the union +
  `LANE_REGISTRY` entry + an `EvidenceCollectorService.collect` slot.
  Evidence parity invariant: whatever the generator sees, the verifier sees.
- **G5/G9 gap confirmed in code**: the only unicode/bidi/zero-width
  sanitizer (`sanitizePackText`, `pack-tool-render.ts:30`) does NOT run on
  ingest. Existing defenses to assert in tests: span-grounding gate
  (`applyGroundingGate`), `sanitizeSourceMeta`, PII redaction, predicate
  canonicalization, fact_trust ranking + `SYNTHESIZE_MIN_FACT_TRUST` floor.
  Red-team fixture idiom: `test/app-fixture.ts` (`createApp`, scriptable
  `StubExtractor`), precedent spec `test/extractor-prompt-injection.unit-spec.ts`.
- **Gates every PR will trip**: `flag-budget.unit-spec.ts` (new engine flags
  → `engine-behavior-flags.golden.json`; RETRIEVAL_ carve-out bounded by
  `retrieval-profile-keys.golden.json`), `engine-gates.unit-spec.ts` (lane
  registry completeness, seam/file-size budgets), `config-catalog-truth`,
  `env-validation`, `contracts-admin-retrieval-profile`, `openapi-doc`,
  `typed-atoms` (kind-set size pin). New profile fields touch 4 lists in
  `retrieval-profile.ts` (:932-1015) + the zod contract.

## PR plan

| PR | Content | Size |
|---|---|---|
| 1 | This doc + spectron-analysis §5 landing intel | docs |
| 2 | G3 spans (deriver emit + row-builder validate + provenance API) | S |
| 3 | G1 answer cache (0091, service, flags, unit+e2e) | M |
| 4 | G2 L3 escalation (session read method, ladder wiring, telemetry) | M |
| 5 | G4 strategy lane (0092, lane, distiller cron, leakage tests) + G7 sweep host | M/L |
| 6 | G5 red-team suite + G9 ingest sanitizer + write-anomaly counter | M |
| 7 | G8 usage→ranking wiring (flip recording, feed readCount as feature) | S |

G6 ships as design here; its build is a later wave (surface too big for this
one).

## G7 — Sleep-time consolidation sweep

**Research verdict.** Letta sleep-time compute (arXiv 2504.13171): offline
rewriting of raw context into learned context gives ~5× less test-time compute
at equal accuracy, up to +13-18% by scaling sleep compute; cost amortizes when
multiple queries hit the same context. The canonical offline op-set: dedup +
summarization + restructure (Letta), typed consolidation decisions
ADD/UPDATE/DELETE/NOOP (Mem0), procedural Build/Retrieve/Update
(Memp — offline refinement +3.7-6.7pp per iteration, AFTER). Idle-window
contradiction sweeps specifically have **no isolated published win** — they
are hygiene; measure before defaulting on.

**v1 design (agreed, hosted on the dreams/promotion scheduler):**

- One idle-window worker, token-budgeted per tenant per night; watermark skip
  when no writes since last sweep.
- Op 1: contradiction sweep over facts touched since watermark only, through
  the 0085 pairwise-closure machinery; invalidations go through the normal
  bitemporal path.
- Op 2: digest refresh keyed off the 0089 staleness-event signal, not
  wholesale.
- Op 3: strategy distillation batch (G4's distiller + dedup-merge).
- Bounds: max LLM calls per sweep, wall-clock cap, dry-run mode emitting
  proposed ops as a reviewable artifact, 0089-style storm guard.
- Metrics: ops proposed/applied/rejected, contradictions found, tokens spent.
