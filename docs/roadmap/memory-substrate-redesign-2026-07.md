# Brain — memory substrate redesign (target architecture, 2026-07-25, rev 1.1)

Supersedes the incremental framing of `locomo-sota-architecture-2026-07.md` §4-5.
Phase A there validated the diagnosis empirically (fact-centric + evidence union:
+3.8pp, p=0.002 — the read path was losing facts that exist). This doc is the
structural answer. **Rev 1.1 incorporates a 15-finding adversarial design review**;
the review's key theme — the danger is not the layer idea but the seams where new
layers meet existing machinery (resolver, redactor, changefeed, job rails, ABAC) —
shaped most of what follows.

## 0. The inversion

Today the dependency arrow points the wrong way:

```
   dialogue turn ──LLM──► facts (source of truth)      raw turn: DISCARDED
                              │
                              ▼
                         retrieval / QA
```

Extraction is a **lossy, irreversible, one-shot compiler whose input is deleted
after compilation**. Every extractor bug is permanent damage; extractor
improvements require re-ingesting data that no longer exists; freshness is
coupled to LLM latency in the ingest hot path; GDPR forget must chase derived
facts it cannot enumerate.

Target:

```
 L0  EPISODES   — immutable, lossless, cheap. Source of truth.
 L1  DERIVED    — propositions / entities / edges / composed events / profiles.
                  A rebuildable INDEX over L0, versioned, provenance-linked.
 L2  ASSEMBLY   — typed, budgeted retrieval + synthesis. A renderer.
```

Everything measured and everything the 2026 SOTA shows fits this shape: Letta's
files+grep (=L0+search, no L1 at all) scores 74.0; ENGRAM's typed lanes are L2
discipline (collapsing them costs −31pp); MIRIX's composed events are an L1
layer; our own temporal edge (+14.7 over full-context) is the one place where
L1 structure already pays. The Carmack analogy that started this line of work
lands exactly here: keep the map, recompile the BSP whenever the compiler
improves — never ship a game that deleted its own map.

## P0 — redaction must be fixed BEFORE any capture (review finding #2)

The current `redactPii` runs BEFORE storage and is destructive and buggy: its
phone regex eats date ranges and ratings (`"2019-2023"` → `[PHONE]`) —
verified empirically. Capturing redacted text into an "immutable, lossless"
substrate would permanently destroy the temporal signal that is the system's
measured strength. Capturing raw text without a PII design moves liability to a
new surface.

P0 therefore precedes everything:
- Replace destructive inline redaction with **reversible tokenization** (PII
  vault: `[PII:kind:ref]` placeholders, plaintext in a scoped vault table) or,
  minimum bar, fix the redactor's date/number false positives with a golden
  test set.
- **Redaction-at-read as policy**: L0 stores vaulted text; the read path
  resolves or masks placeholders per caller scope (`brain:read_pii`).
- Each episode gets a **piiClass computed at write** (review #10) so the
  episodic retrieval lane can be scope-gated like predicate-classed facts are
  today — the episode lane must not become the tenth read surface that
  bypasses the row fence (the exact "phantom fence" class the 2026-07-11 audit
  closed).

## 1. L0 — episodic substrate

New table `episode` (SCHEMAFULL, additive):

```sql
DEFINE TABLE episode SCHEMAFULL;               -- NO CHANGEFEED (see §2.6)
DEFINE FIELD kind           ON episode TYPE string;   -- 'turn' | 'event' | 'observation'
DEFINE FIELD conversationId ON episode TYPE option<string>;
DEFINE FIELD messageId      ON episode TYPE string;
DEFINE FIELD speaker        ON episode TYPE option<string>;
DEFINE FIELD addressee      ON episode TYPE option<string>;
DEFINE FIELD text           ON episode TYPE string;   -- vaulted per P0, verbatim otherwise
DEFINE FIELD piiClass       ON episode TYPE option<string>;
DEFINE FIELD occurredAt     ON episode TYPE datetime;
DEFINE FIELD recordedAt     ON episode TYPE datetime DEFAULT time::now();
DEFINE FIELD embedding      ON episode TYPE option<array<float>>;
DEFINE FIELD lang           ON episode TYPE option<string>;
DEFINE FIELD userId         ON episode TYPE option<string>;    -- 0055 scope semantics
DEFINE FIELD source         ON episode FLEXIBLE TYPE object;
DEFINE INDEX episode_msg_uq ON episode FIELDS conversationId, messageId UNIQUE;
```

Design points from review findings #12, #13:
- **No stored `seq`, no stored `sessionId`**: seq is derived by
  `(occurredAt, messageId)` ordering at read; sessionization (time-gap
  segmentation) happens at derivation time, not write time. Removes the
  cross-pod counter race and keeps the write path one INSERT.
- **Idempotent dual-write**: `UNIQUE(conversationId, messageId)` makes ingest
  retries safe; a crash between fact-write and episode-write leaves a gap that
  the nightly reconciler backfills from the mention audit trail.
- **Capacity honesty**: a 1536-dim float64 embedding is ~12KB/row in Surreal —
  1M turns ≈ 13GB/tenant before text and BM25 postings. Episodes therefore
  embed at **reduced dimension (768 or 256, f32 where supported)** — episodic
  recall is a fallback lane, not a precision instrument — and HNSW on episodes
  is opt-in per tenant. A capacity table gates P1 rollout.
- **Per-language BM25 analyzers**: the existing `content` analyzer
  (`lowercase, ascii, snowball(english)`) mangles Cyrillic — fine for
  English-ish predicates, fatal for verbatim RU dialogue. `episode.lang` picks
  the analyzer; this is a P1 deliverable, not a follow-up.
- **Immutability is enforced, not assumed** (review #15): no UPDATE path in
  code, an assert-style unit test, and the known caveat that the 0005 DB fence
  is phantom for system users is documented on this table too.

**Freshness property (load-bearing):** search sees an episode the moment it
lands via the episodic lane (§3) — the "fact not yet extracted" window
disappears. Freshness comes from L0; quality comes from L1. This is also the
read-your-writes answer during async derivation (§2.5).

## 2. L1 — derivation, not extraction

### 2.1 The derivation registry

The generic table from `cascade-recompose-2026-07.md` Phase 2 becomes the
backbone of L1:

```sql
DEFINE TABLE derivation SCHEMAFULL;
DEFINE FIELD artifact       ON derivation TYPE record;
DEFINE FIELD artifactKind   ON derivation TYPE string;  -- 'proposition'|'edge'|'composed'|'aggregate'|'profile'
DEFINE FIELD dependsOn      ON derivation TYPE array<record<episode>>;
DEFINE FIELD deriverVersion ON derivation TYPE string;
DEFINE FIELD inputsHash     ON derivation TYPE string;  -- per-artifact, drives diff-emission
DEFINE FIELD computedAt     ON derivation TYPE datetime;
DEFINE FIELD staleAt        ON derivation TYPE option<datetime>;
DEFINE INDEX derivation_dep_idx ON derivation FIELDS dependsOn;      -- forget/invalidation traversal
DEFINE INDEX derivation_artifact_idx ON derivation FIELDS artifact;
```

**Honesty about existing rails (review #6):** `fn::mark_derived_stale` (0072 —
prior docs miscited it as 0074, fixed) is typed over `knowledge_fact.derivedFrom`
and cannot traverse episode dependencies; `recompose.recompute` only handles
`compaction-summary` artifacts. P3 therefore explicitly builds: a
registry-based traversal function (indexed on `dependsOn`), a generalized
recompute dispatcher per `artifactKind`, and keeps 0072 for the legacy
fact→fact cascade until retired.

### 2.2 Versioned derivation and the A/B that actually works (review #3)

`fn::resolve_fact` selects candidates by `(entityId, predicate, status)` with
no version dimension — batch-writing deriver v2 through it would supersede v1
incumbents at write time, destroying the baseline before any "switch". So:

- `knowledge_fact.derivedVersion` (option, absent = legacy) joins the
  **candidate WHERE** exactly like the 0055 `userId` scope did: v2 propositions
  resolve only against v2 incumbents.
- The read path pins a version per tenant (`RETRIEVAL_DERIVED_VERSION`);
  eval runs pin explicitly. Losing versions are garbage-collected by a batch
  job, not by supersede semantics.
- Rollback = repoint the pin. Nothing in v1 was mutated.

### 2.3 Emission discipline: diff, don't re-shout (review #1, #8)

Naive window re-derivation re-emits identical propositions every turn; the
resolver `CREATE`s unconditionally and fresh emissions out-recency their own
incumbents — self-superseding churn, changefeed amplification, staleness
cascades, and supersede chains that outrun recompose's 8-hop follow. Two
mandatory mechanisms:

- **Deriver-side diff-emission**: the registry's per-artifact `inputsHash`
  lets the deriver emit only propositions whose supporting span content
  changed since the last run; unchanged propositions are not re-submitted.
  Re-emission of an *improved* proposition (antecedent resolved by later
  context) is a legitimate supersede — that is the one case that SHOULD flow.
- **Resolver-side idempotency short-circuit**: same origin + same normalized
  value + same validFrom → NOOP before CREATE. Cheap, fixes the historical
  "no messageId idempotency" note in the eval harness too.

Scheduling (review #8): the worker rails have no debounce/notBefore primitive,
and per-session `dedupKey` would collapse onto succeeded jobs forever. P3 adds
a **session-watermark task**: one pending task per session keyed by session
watermark, `notBefore = last-turn + gap`, claim compares `inputsHash` and
no-ops when nothing changed. Cost model: prod turn pacing means most windows
derive once (per-session O(N) tokens); the benchmark's rapid-fire ingest is
the worst case and is priced explicitly, not hidden behind "same budget".

### 2.4 Propositions, and a conflict key that survives them (review #4)

The retrieval unit becomes a **self-contained proposition** with resolved
referents and time: `"Caroline moved to the US from Sweden around 2019"`, not
`gift_location: Sweden`. On `knowledge_fact`: new `proposition` field becomes
the embedding basis + BM25 haystack + synthesis render text; `predicate`/
`object` remain structured metadata (packs, ABAC predicate policies, closed
CRM vocabularies keep working).

But conflict resolution cannot stay keyed on `predicate =` — with coined
predicates already 81.5% singletons, the candidate set is empty exactly where
bitemporal machinery matters. P3 replaces the conflict key for proposition-era
facts: candidates = same entity + **aspect key** (a short canonical topic slug
the deriver emits: `residence`, `pet`, `relationship_status` — a closed-ish
space the consolidation prompt already gestures at) with a cosine fallback at
a **recalibrated** threshold on the proposition basis (the current
`similarityThreshold` was calibrated on fragments and does not transfer).
Supersede/contradiction/corroborate semantics themselves are unchanged — they
finally get inputs they can act on.

The failed sentence-embedding experiment (−2.9pp) does not refute this: it
prefixed every fact with the same canonical name (collapse); deriver-written
propositions have natural varied surface form with inline time.

### 2.5 Ingest contract v2 (review #7)

Today ingest returns `extractedFactIds` synchronously and consumers (MCP
tools, scenario runner, openclaw/deus/hermes) read them. Async derivation
breaks that silently. Decision: **async-only derivation with an explicit
contract change** — v2 ingest returns `202 { episodeId, derivationTask }` with
poll/webhook completion, v1 keeps the old shape via a deprecation shim that
waits (bounded) for the window task on request. No hidden hybrid double-LLM
path: freshness during the gap is served by the episodic lane, which is the
architectural answer to read-your-writes, and the one the eval can verify.

### 2.6 Deletion: forget ≠ retention (review #5)

Three rules, encoded in the registry:
- **Forget (GDPR)**: delete the subject's episodes AND add the subject to a
  per-tenant **suppression list the deriver must consult** — otherwise
  re-derivation over surviving interlocutor turns resurrects the erased
  subject ("How was Sweden, Caroline?"). Forget-triggered invalidation
  retracts derived artifacts **without re-derivation** of their windows.
- **Retention (ops)**: expiring old episodes marks derived artifacts
  `sourceExpired` — they survive (long-term memory must not erode on a
  schedule); only forget kills derived knowledge.
- **No CHANGEFEED on `episode`** — a 30-day `INCLUDE ORIGINAL` feed would
  keep forgotten verbatim text readable after deletion. Forget invokes the
  invalidation cascade synchronously; derivation scheduling uses the task
  watermark, not a feed.
- Legacy facts without registry rows keep the current enumerate-style forget
  path forever; the doc says so out loud (two-era reality, review #9).

### 2.7 Two-era corpus: synthetic backfill (review #9)

Pre-substrate facts have no episodes and can never be re-derived — accepted.
But they must not silently lose the retrieval contest to proposition-era
facts (question-shaped embeddings systematically beat fragments in one KNN
space). Fix: a one-shot **synthetic proposition backfill** — render a
proposition for every legacy active fact from `predicate/object/entity/
validFrom` (LLM batch, no episodes required), stamp `derivedVersion:
'backfill-v1'`, re-embed. One basis, one analyzer, era-blind ranking; the
per-fact provenance stays honest (`source.kind: 'legacy-backfill'`).

### 2.8 Composers (write-time compute with readers)

`consolidate`/`recompose` become L1 composers over episode spans: composed
cross-session events (MIRIX), per-(entity, aspect) aggregates ("activities:
pottery, painting, camping…" — the enumeration answer), and per-principal
profiles (Memobase). All registered, versioned, invalidated via the registry,
and — unlike today's promotion/compaction output — actually read by L2.

## 3. L2 — typed, budgeted assembly

One retrieval contract for QA/synthesis (ENGRAM discipline; PA2 defaults):

```
lanes:    episodes (hybrid top-k, chronological render, scope/piiClass-gated)
          propositions (fact-centric global top-k — PA2 default)
          composed/aggregates (top-k)
          profile (per principal entity)
budget:   ~2k evidence tokens, per-lane caps, typed prompt sections
evidence: multi-hop KG lane contributes its hop union (PA2 default)
```

- Entity buckets survive as the presentation of the propositions lane and the
  KG hop mechanism (multi-hop beats FC in its class — preserved), but stop
  gating the window.
- Chronological ordering for dated evidence; date instruction returns
  reworked: "answer with the mention-time convention; do not resolve forward"
  (the measured v1 failure mode).
- Agentic loop stays the premium path — but see the P2.5 kill-gate below.

## 4. What dies / what survives

| dies | survives (strength, untouched) |
|---|---|
| per-turn isolated extraction | bitemporal supersede/contradict semantics (temporal +14.7 vs FC) |
| `predicate: object` as retrieval identity | entity graph + edges + multi-hop chains |
| raw-turn discard | ABAC / scopes / row fence (extended to episodes, not bypassed) |
| extraction-in-ingest-hot-path | never-abstain answer contract |
| destructive write-time redaction | changefeed rails for knowledge tables (not episodes) |
| predicate-keyed conflict resolution (proposition era) | worker rails (+ watermark primitive) |
| unread consolidation tiers | occlusion module (subsumed; measured null at read on top of fact-centric) |

## 5. Phasing (each gated, each measured; substrate first)

- **P0 — redaction redesign** (vault/tokenization + piiClass + golden tests).
  Gate: redactor golden suite; no date/number false positives.
- **P1 — capture L0**: `episode` + idempotent dual-write + reconciler +
  per-lang analyzers + capacity table. Every day without L0 is data that can
  never be re-derived — but capturing damaged text is worse than waiting for
  P0. Gate: write-path p50 unchanged; storage math signed off.
- **P2 — episodic lane in assembly** (budgeted, gated, typed). Honest gate
  (review #11): paired McNemar on dev-5, pre-registered lane ablation;
  addressable mass is the ~10pp ABSENT slice, so expect +2-4pp, not miracles;
  the 07-19 "quotes distract" precedent is the named risk. **P2 failure
  degrades lane E to an agent-path tool; P3 proceeds regardless** (it is
  justified operationally, not by benchmark points).
- **P2.5 — Letta kill-gate** (review #14): agent-qa ReAct over L0 episodes
  (iterative search, no new L1). If this alone reaches target accuracy, the
  L1 program shrinks to its operational core (forget, versioning, freshness)
  and the composers wait. Cheapest experiment with the largest scope impact —
  it runs before any P3 spend.
- **P3 — derivation registry + versioned session-window deriver**:
  registry + traversal fn + generalized recompute + `derivedVersion` resolver
  scope + aspect conflict key + diff-emission + watermark tasks + contract v2
  + suppression-list forget. First A/B: deriver v2 vs legacy on the same L0.
- **P4 — synthetic backfill + composers with readers.**
- **P5 — assembly contract consolidation**; retire flag sprawl.

Eval gates throughout: corrected-labels dev-5 + McNemar (noise-aware), strict
judge (LoCoMo-Refined) second axis, held-out conv-44..50 once per milestone,
evidence-token budget reported next to accuracy. Prod gates: ingest p50,
derivation SLA, forget E2E across BOTH eras.

## 6. Honest costs and risks

- **PII/storage**: L0 verbatim + vault is a real new liability surface — P0 is
  the price of admission, and the registry then makes forget *sounder* than
  today (walk `dependsOn`, not guesswork), at the cost of the suppression-list
  machinery.
- **Compute**: +1 reduced-dim embedding per turn; window derivation ≈ current
  extraction cost at prod pacing, worst-case (rapid-fire) priced explicitly;
  corpus re-derivation and legacy backfill are explicit paid batches.
- **Complexity**: the registry, versioning, and dual deletion semantics are
  genuine new machinery. The P2.5 kill-gate exists precisely to shrink this
  scope if a lossless substrate + agentic read turns out to be enough.
- **Known unknown**: open-domain slid (n.s., n=46) under every Phase-A config;
  P2's episodes lane is the most plausible cure (speculative questions want
  raw context) — tracked at its gate.
