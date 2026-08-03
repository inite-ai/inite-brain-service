# Engine architecture audit — 2026-08-03

Five parallel auditors over the engine core (write path, substrate +
derivation, retrieval read path, synthesis, configuration), each with
file:line evidence, cross-checked against
docs/roadmap/lme-sota-research-2026-08.md. Verdict up front: **the
engine is a collection of measured-good components wired by flag
history, not a designed system.** Three write tracts diverged into
incompatible ontologies; the derived-world lifecycle has catastrophic
footguns; the read path ships an accidental default; verification does
not cover what the prompt actually contains; the config layer lies to
operators. Nothing here contradicts the measured wins — it explains
why they cost so much to obtain.

## The six structural themes

### A. Two engines: the eval world and the prod world diverged

1. **The window-deriver bypasses the write primitive entirely**
   (window-deriver.service.ts:404-423): hand-built
   `INSERT INTO knowledge_fact`, never `fn::resolve_fact`. Derived
   facts get no supersede/compete (contradictory propositions both stay
   active), no corroboration, no trustSnapshot, no lang/userId,
   confidence hardcoded 0.85. Meanwhile the ranker multiplies by
   trust/corroboration factors and runs the HyPE leg — all constants or
   dead in the only world our benchmarks run on. STRUCTURAL.
2. **The dialogue tract promises EDC canonicalization and skips it**
   (prompts.ts:110-113 vs extractor-refine.service.ts:40). Coined
   predicates land raw → `policyFor` falls back to `bitemporal`
   semantics, every fact takes the serialized per-fact mutex path
   (INGEST_BATCH_FACTS is a no-op on the shipping tract), and
   dedup/corroboration key on (entity, predicate) so they never fire.
   STRUCTURAL.
3. **Three vocabularies share one `predicate` column** (closed ids /
   open coined / 16 aspect slugs). Consumers keyed to tract 1 only:
   artifacts/templates.ts hardcodes 'preference'/'said'/
   'interacted_with' (fields permanently empty on live tracts),
   chatter demotion unreachable, per-predicate diversity cap inert on
   tract 2 and truncating enumerations on tract 3, predicate-router
   boost matches tract 1 only. STRUCTURAL.
4. `object` has four shapes in one column (verbatim span / word-subset
   / normalized / full sentence) with one similarity threshold (0.85)
   tuned on short spans. MAJOR.
5. **Cross-entity fact dropping in merge**: merge.ts:67-69 dedups on
   {predicate, object} ignoring entityIndex — two people sharing a
   value collide, one fact is silently dropped. MAJOR (live bug).
6. Facet routing not gated on the dialogue profile it requires
   (2-3× LLM calls whose facts the grounding gate then drops). MAJOR.
7. Extraction-pattern cache is write-only under the live tract
   (2 writes/clause/turn, replay never fires). MAJOR.

### B. Derived-world lifecycle: catastrophic footguns

8. **`gc()` deletes the live world on any pod whose pin is unset**
   (window-deriver.service.ts:243-244): unset pin → empty keep-set →
   DELETE every derived version including mid-build ones, then deletes
   the registry evidence. Unrecoverable without a paid re-derive.
   STRUCTURAL — fixed same-day (keep-set from registry + refuse-on-empty).
9. **The read pin is process-global, tenant-global, runtime-mutated**
   (window-deriver.service.ts:213 writes process.env). Deriving tenant
   A flips the pin for every tenant on that pod; other pods and worker
   roles never see it; restart silently rolls back; the registry row
   (`status='live'`) is a DB truth no reader consults. STRUCTURAL.
10. **"Fork never rewrite" holds for exactly one writer.**
    aggregate-composer and segment-composer delete+recreate in place
    with no guard; `episode_segment` has NO version column (the design
    doc's "segments@v" does not exist); compaction/dreams/promotion are
    version-blind — under a pin, compaction flips derived sources to
    invisible while the summary lands in the legacy namespace the
    pinned reader never queries: silent memory loss. STRUCTURAL.
11. No transaction in deriveConversation: delete → minutes of LLM
    calls → insert; the live world is empty for that conversation the
    whole window (force mode advertises this). MAJOR.
12. **L0 is not the universal raw layer**: only mention-ingest writes
    episodes; documents pipeline, MCP write-tools, POST /v1/facts,
    link-ingest, pack-seed, dreams all produce L1 with no L0
    antecedent — a re-derive loses them. STRUCTURAL (vs the driver
    design doc's core claim).

### C. GDPR / privacy at L0

13. **Erasure stops at L1**: entity-forget covers all derived fact
    versions but touches neither `episode` nor `episode_segment` — the
    erased subject's verbatim turns remain retrievable via both lanes
    and GET /v1/episodes, and a re-derive RESURRECTS the deleted
    facts. user-forget deletes episodes but not segments (mixed-user
    windows = unattributable orphans). STRUCTURAL.
14. **The 0055 user-scope fence is bypassed by all three L0
    surfaces**: episode-read-store searchText/byIds/page and
    segment-lane carry no userId predicate; GET /v1/episodes serves
    the whole tenant's raw turns to any brain:read key. STRUCTURAL.

### D. Read path: the default is flag history, not design

15. **fact-centric silently voids rerank, PPR, edge-expansion scores
    AND `limit`** (search.service.ts:469-509): stage 7's cross-encoder
    order is computed, paid for, and overwritten; no re-slice to limit
    (up to 48 entities returned to a caller asking 10); occlusion's
    per-entity cap made inert. This is our eval config. STRUCTURAL.
16. **No cross-encoder in the default path** — a local, vendor-free
    bge-reranker worker exists and is default-off, while SOTA's
    top lever is exactly this (SmartSearch 88.4 no-graph). STRUCTURAL.
17. **Temporal is a hard filter, never a boost** — no
    interval-overlap scoring; a bad asOf is a recall cliff (Hindsight:
    overlap + distance decay = 91.0 TR). STRUCTURAL.
18. **Verbatim has no read-path expression** — L0 reaches answers only
    as a prompt appendix; quotes never enter SearchHit, never get
    scored/reranked against facts. The field's clearest SSA signal has
    no retrieval-side implementation. STRUCTURAL.
19. No entity-expansion rewrite; multi-hop never re-plans (fixed plan,
    empty set just breaks). MAJOR.
20. Scoped DB connection held across LLM round-trips (pool of 8);
    synthesize = 5 sequential awaits incl. a full second search for
    standing instructions. MAJOR.
21. Two contradictory fusion doctrines (convex-documented-better vs
    RRF in segment lane); mixed orderings concatenated across a seam;
    module-import-time env reads. MINOR set.

### E. Verification and citations don't cover the prompt

22. **The verifier sees only factLines** — transcript quotes, interval
    tables, standing instructions are invisible to it. Strict mode
    drops correct quote-built answers; lenient/answer ships quoted L0
    content with zero faithfulness scoring and zero citations. The
    verbatim-recall default makes this the NORMAL path for "what did
    you suggest". STRUCTURAL.
23. **The ordering frame is citation-hostile by construction**:
    system demands inline [knowledge_fact:…] per claim, the frame
    demands bare list lines, BEAM splits on newlines → citation ids
    become spurious scored items. Part of the event_ordering zero.
    MAJOR.
24. Real prompt contradictions: "use date arithmetic" adjacent to "do
    NOT recompute intervals"; elapsed annotations promised when absent
    (no asOf); always-commit system rule vs ask-which-is-correct
    contradiction note; exhaustive-list lanes vs 512-token cap with NO
    finish_reason check — truncation = generator_error = silent
    abstain. MAJOR.
25. The temporal lane force-anchors from asOf BEFORE consulting
    SYNTHESIZE_DATE_CONTEXT=0 — the ablation knob is not honored for
    routed questions (one-variable legs were contaminated). MAJOR.
26. guardrails='answer' is a triple bypass — also zeroes the
    fact-trust floor, which is orthogonal to abstention. MAJOR.
27. No Lane abstraction: adding one lane = 14 edit sites across 5
    files; two parallel lane type systems (DispatchLane vs AnswerLane)
    with members only one side knows. STRUCTURAL (velocity).

### F. Configuration lies and has no tenant dimension

28. **`runtimeMutable: true` is false for 15+ catalog entries** —
    flags captured in constructors; the config UI tells operators a
    live flip works when it does nothing. Includes SEARCH_RERANKER
    (catalog also claims default '1'; code says off). STRUCTURAL.
29. **No per-tenant profile concept** while the pattern already
    exists (PackExtractionProfile threads per-tenant by argument).
    Genre-dependent behavior is process-global env → one deployment
    cannot serve two corpus genres; ~45 flags read per-request via
    raw process.env (~25-30 reads per synthesize call). STRUCTURAL.
30. Three incompatible boolean idioms: `=== 'true'` sites where `=1`
    does nothing (EXTRACTOR_LOCAL_NER_ENABLED), `=== '1'` sites where
    `=true` does nothing, `!== 'false'` sites where `=0` does nothing
    — none in KNOWN_BOOLEAN_FLAGS, so no warning ever fires. MAJOR.
31. Catalog drift: 7 wrong defaultValues (incl. PREDICATE_ROUTER
    advertised on, actually off), 114 read-but-uncatalogued keys,
    EPISODE_SUBSTRATE_ENABLED read NOWHERE while the catalog documents
    a dependency on it (capture is unconditional). MAJOR.
32. Four overlapping flags inject verbatim L0 into the same prompt;
    undeclared flag precedence (dialogue overrides object-normalize).
    MINOR.

### Same-day self-findings (this session's own work, same standard)

- projection watermark fabricated (`time::now()` at completion, not
  max(recordedAt) consumed) — the future incremental builder would
  skip everything ingested during the run.
- subscription dispatcher: no index on recordedAt (per-minute full
  scan), no leader lease (double-push per pod), breaker keyed by URL
  across tenants, secret stored plaintext.
- SYNTHESIZE_ROUTER_LEXICON_V2 "default-on" is dead at shipped
  defaults (router itself is a genre flag, default off).
- registry `begin` has no lease/owner — crashed pod leaves permanent
  `building`; complete() can mark a 90%-skipped world live.

## Fix waves (ranked by blast radius)

- **W0 — same-day futility guards (DONE where marked):**
  gc() keep-set from the registry + refuse-on-empty [fixed this
  session]; fork-guard comparisons must use registry, not env.
- **W1 — privacy/data:** forget cascades reach episode +
  episode_segment (+ suppression so re-derive cannot resurrect);
  userId fence on all three L0 read surfaces; recordedAt index;
  subscription leader-lease + per-sub breaker + hashed secret.
- **W2 — version lifecycle:** per-tenant read pin resolved from the
  projection registry (env = bootstrap only, delete the runtime
  write); version column + fork guard for segments/aggregates;
  version-aware compaction/dreams or fence them off derived worlds;
  staging-version + swap instead of delete-then-insert.
- **W3 — one write primitive:** derived rows through a version-scoped
  resolve (supersede/corroborate/trust live in eval worlds);
  canonicalize coined predicates into an alias column; append_only
  default for open predicates; object-shape discipline + per-tract
  similarity thresholds; fix cross-entity merge dedup (add
  entityIndex to the cluster key).
- **W4 — read path to SOTA:** fact-centric as selection over the
  reranked window + re-slice to limit; local cross-encoder default-ON;
  temporal overlap boost alongside the closure filter; episode/segment
  fusion leg (verbatim INTO SearchHit); post-leg entity-expansion
  second retrieval; release the DB connection across LLM awaits;
  parallelize synthesize's lane collection.
- **W5 — verification/citations:** verifier receives the full
  evidence bundle (facts + quotes + tables) or quotes get synthetic
  citable ids; ordering frame citation mode; finish_reason handling;
  answer-mode keeps the trust floor; Lane as a first-class object
  (one registry, one type system).
- **W6 — config as a system:** RetrievalProfile resolved per-tenant
  in the guard (env = default profile); per-request ConfigSnapshot;
  runtimeMutable derived-not-asserted (lint test: catalog claim vs
  constructor capture); catalog reconciliation test (defaults +
  coverage); one boolean idiom everywhere; delete dead/superseded
  flags.

## Cross-check against measured reality

The audit explains the measurement history rather than contradicting
it: lane legs came back null on BEAM because the default read path
(no reranker, no verbatim leg, temporal-as-filter) caps what prompt
shaping can recover; the eval world neutralizes the trust stack the
ranker assumes; and ablations on DATE_CONTEXT were partially
contaminated by the temporal lane's forced anchor. SOTA parity is
therefore not "more lanes" — it is W3+W4 (write primitive + read
path), with W1/W2 as the safety floor.
