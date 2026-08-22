# Spectron (SurrealDB Agent Memory) — competitive analysis (2026-08)

SurrealDB — the vendor of our storage engine — has launched an agent-memory
product: **SurrealDB Agent Memory**, developed under the codename **Spectron**
(runtime artifacts keep the codename: `spectron`/`spectrond` binaries,
`SPECTRON_*` env vars, `@surrealdb/spectron` SDK, `*.spectron.cloud` hosted
endpoints). It is a hosted/self-deployed memory-and-knowledge layer for AI
agents, exposed over HTTP, MCP, and generated SDKs — i.e. the same product
category as brain, built by the vendor of our own substrate.

Docs root: <https://surrealdb.com/docs/agent-memory>. All ten target subpages
fetched successfully on 2026-08-22 (zero 404s):

| Page | URL |
|---|---|
| Tri-Temporal Model | `/docs/agent-memory/architecture/tri-temporal-model` |
| Eight Pillars and Categories | `/docs/agent-memory/architecture/eight-pillars-and-categories` |
| The Accuracy Promise | `/docs/agent-memory/welcome/accuracy-promise` |
| Coherence, Retrieval, and Cost Tiers | `/docs/agent-memory/architecture/coherence-retrieval-and-tiers` |
| Provenance and Traceability | `/docs/agent-memory/mental-model/provenance-and-traceability` |
| Memory Lifecycle (supersession/decay/forget) | `/docs/agent-memory/mental-model/memory-lifecycle` |
| Contexts and Scope | `/docs/agent-memory/mental-model/contexts-and-scope` |
| Surface, Models, and Security | `/docs/agent-memory/architecture/surface-security-and-models` |
| How It Works | `/docs/agent-memory/welcome/how-it-works` |
| Agent Guide (AGENTS.md) | `/docs/agent-memory/reference/agents` |

Also fetched: the section index, `/docs/agent-memory/integrations`,
`/docs/agent-memory/reference`, `/docs/agent-memory/quickstarts/embedded`.

## 1. Their architecture, faithfully

**Substrate.** An application tier on SurrealDB storing graph + vector +
document + relational + geospatial records with ACID, "graph-resident traces"
and "tri-temporal belief history" distinguishing "what was said, what is true
now, and what used to be true".

**Tri-temporal model.** Three clocks: *system time* = SurrealDB MVCC
versioning ("time-travel queries on previous database states"); *known time* =
when a belief was first captured, queried via `as_of` over supersession
chains; *valid time* = `valid_from`/`valid_until` for when a fact held in
reality. Deletion is deliberately secondary: "Memories are **superseded** or
**aged**; three clocks answer three different questions."

**Eight pillars.** Authoritative (vetted org truth), Experiential (what was
said in conversation), Reconciliation (conflicts become explicit uncertainty
records, "not last-write-wins"), Elaboration (connecting separately-stored
facts), Reflection (insights minted from queries), Consolidation (repeated
observations → durable beliefs), Calibration (per-assertion source sureness +
reconciler confidence), Collective (shared memory across agents/people with
separate provenance).

**Six experiential categories.** Episodic (verbatim sessions/turns in order),
Identity, Knowledge, Context ("what matters right now"), Instructions
(behavioural, applied at prompt assembly), Uncertainty (explicit "we do not
know yet" records).

**Provenance.** A `source` object on every fact-bearing record — kind
(turn/document/upsert/reflect/elaboration/consolidation), `source.ref`,
temporal anchors, `source.span` character offsets into the original message,
trust prior, `derived_from` lineage. Two crisp invariants worth quoting: "no
fact-bearing record is anonymous" and "citations are stored data, not
best-effort model prose". Writes emit `decision_trace`, reads emit
`retrieval_trace`, chat/reflect emit `response_trace`; traces are queryable
graph nodes (`GET /api/v1/{ctx}/traces`).

**Retrieval and cost tiers.** Coherence across five axes (semantic, lexical,
relational, time, space/geo). Retrieval is "hybrid by design": BM25 + vectors
+ bounded graph hops + keyword bridges + section embeddings + Personalized
PageRank + geographic filters + trace-derived features (prior
retrieval success/failure) fused into one ranking. Queries cascade through a
four-tier ladder, cheapest first: **T1** direct structured lookup ("minimal
tokens — often nothing sent to an LLM"), **T2** response reuse (entity-aware
cache of prior responses whose cited facts are still current), **T3** hybrid
retrieval + LLM synthesis over a bounded 256-candidate pool, **T4**
full-context fallback when T3 confidence < 0.40 ("highest token use —
explicit escalation, still traceable").

**Lifecycle.** Three separated mechanisms: *supersession* (prior belief
"closed in time, not erased"), *decay* (category-dependent fading; retrieval
use reinforces; consolidation crystallizes), *forget* (`POST /forget`,
user-driven; default soft-deletes from retrieval while keeping audit history;
`purge: true` for "harder erasure" — semantics unspecified; future mentions
can regenerate the memory).

**Contexts and scope.** A Context = its own SurrealDB `(namespace, database)`
pair; "nothing crosses Context boundaries". Inside a Context, hierarchical
scope tags (`org/acme/user/alice/`) with OR-of-ANDs visibility. Documented
limitation: "Scopes do **not** give you a second profile or a second
response-cache" — hard per-customer isolation requires a Context (= separate
DB + keys) per customer.

**Surface, models, security.** HTTP `/api/v1/{ctx}/…` (facts, facts/batch,
documents, query, chat with SSE, reflect, forget, traces); MCP at `/mcp` with
Bearer + `X-Spectron-Context`, exposing **seven tools**: `remember`,
`recall`, `context`, `reflect`, `forget`, `upload`, `inspect`. Five
configurable pipeline roles (extraction, embedding, reconciliation,
synthesis, elaboration/consolidation) over OpenAI-compatible + Anthropic +
Google clients; embedding model is deployment-fixed. Grants are `noun:verb`
(`memory:read|write|forget`, `scope:*`, `grant:manage`), delegation via
`X-Spectron-On-Behalf-Of` (depth 1), RFC 7807 errors, ingest-time prompt
sanitisation. SDKs in ~9 languages plus framework adapters — including
`spectron-hermes` and `@surrealdb/spectron-openclaw` (see §3). Despite the
"embedded library" positioning, the embedded quickstart concedes there is
**no supported in-process API** — everything runs against a deployed server.

**Accuracy Promise.** An architectural pledge — "can someone watch the
substrate in real time and verify that the agent is operating on the right
information?" — built from structured facts, mandatory provenance, visible
probabilistic lineage, tri-temporal change history, uncertainty-not-overwrite
reconciliation, auditable traces, separated forgetting. **It contains zero
benchmark numbers.** Across every page we fetched there is not a single
dataset name (LoCoMo, LongMemEval, BEAM…), accuracy percentage, or ablation.

## 2. Capability comparison — Spectron vs brain

| Axis | Spectron | Brain | Verdict |
|---|---|---|---|
| Temporal model | Tri-temporal: MVCC system time, known time via `as_of` + supersession chains, valid time via `valid_from/until` | Same three axes: SurrealDB MVCC underneath, `recordedAt/retractedAt` + `asOf` (knowledge time), `validFrom/validUntil` (valid time) — [bitemporal-semantics](../bitemporal-semantics.md), Allen-interval conflict resolution; plus a raw **episode substrate** with per-turn timestamps under the derived world | **Parity on axes; we add the raw layer.** Their "tri-temporal" is our bitemporal + the MVCC everyone on SurrealDB gets for free — same three clocks, better marketing name |
| Provenance | Mandatory `source` object incl. char `span`, trust prior, `derived_from`; graph-resident decision/retrieval/response traces | Mandatory source + confidence on every fact; [fact provenance API](../fact-provenance-api.md) (`GET /v1/facts/:id/provenance`); citation-bearing synthesis where a verifier LLM checks every `[factId]` claim | **Parity, split edge.** They store char spans (worth stealing); we *verify* citations rather than just store them |
| Per-user scoping | Hierarchical scope tags (`org/user/project/team`), OR-of-ANDs visibility; scopes do NOT isolate profiles/response caches | Two-level: tenant + `userId` per-user memory, fail-closed (omit → tenant-global only), DB-level PII fencing, ABAC flags | **Their model is more general; our guarantees are harder.** Steal the hierarchy shape, keep fail-closed semantics |
| Forgetting / GDPR | `POST /forget` defaults to soft-delete (audit history kept); `purge: true` "harder erasure", semantics unspecified; decay + supersession first-class | `retract_fact` (soft, auditable) + admin-scoped `forget_entity` hard-delete cascade with tombstones (reason enum incl. `gdpr_request`), e2e-tested (migration 0080/0085); tombstones surface in `memory_diff` | **Us.** Their default keeps the data; our hard-delete is a tested product surface |
| Retrieval mechanics | Hybrid fusion: BM25 + vector + graph hops + keyword bridges + Personalized PageRank + geo + trace-derived features; retrieval_trace per query | Hybrid dense+BM25 lanes (lane registry, HNSW), graph_retrieve, planner-LLM multi-hop with evidence chains, communities, verifier-gated synthesis with abstention, per-tenant retrieval profiles | **Rough parity, different bets.** They fuse more static signals (PPR, geo, trace features); we do active addressing (multi-hop planner, search-loop) + verification |
| Cost tiers | Shipped 4-tier ladder: structured lookup → response reuse → hybrid+synthesis (256-cand) → full-context fallback at <0.40 confidence; cheapest-first, traceable escalation | Our fovea program ([memory-research §8–9](memory-research-2026-08.md#8-foveated-memory--the-resolution-cascade-program-e-fovea-2026-08-17)): L0 profile/digest → L1 facts → L2 raw windows (built, `RETRIEVAL_RAW_WINDOW`) → L3 full-transcript escalation (not built); triggers exist but never escalate UP a layer | **They shipped the shape we designed** — strong external validation of the pointer/cascade frame, zero numbers behind it. Their T2 response-reuse cache is a tier we lack; our L2 raw-window replay is a tier they don't describe |
| Eval evidence | "Accuracy Promise" = architecture prose; **no benchmark numbers, datasets, or percentages anywhere in the docs** | Published strict protocol ([eval-protocol](../eval-protocol.md)): 3 orthogonal axes (LoCoMo/LongMemEval/BEAM), fixed strict judge, own FC baseline, paired McNemar, dev/held-out split, recorded nulls & regressions | **Us, decisively.** This is our sharpest, cheapest-to-communicate differentiation |
| MCP surface | 7 coarse verbs: `remember`, `recall`, `context`, `reflect`, `forget`, `upload`, `inspect`; `/mcp` endpoint, Bearer + context header | 19 read-scope tools + 2 resources; +8 write, +1 admin (see §4 list); Streamable HTTP `POST /mcp/:companyId` + [@inite/brain-mcp](../../clients/brain-mcp/README.md) stdio shim | **Different philosophies.** Theirs is onboarding-friendly; ours is a real graph instrument (multi-hop, contradiction preflight, diff, provenance). Steal the simplicity as a facade, not as a replacement |
| Multi-tenancy | Hard isolation = one Context = one `(namespace, database)` + own keys per customer; scope tags inside a Context share profiles/caches | One deployment serves many tenants keyed by `companyId`: per-tenant profiles (retrieval/extraction), quotas, keys, packs; per-user scope inside each tenant | **Us operationally.** Their per-customer hard isolation costs a database per customer; ours is native multi-tenant with tenant-level config |
| Extensibility | Fixed pillars/categories; per-context model-role config only; no user-defined ontology surface found | [Domain Packs](../domain-packs.md): signed manifests, predicates + extraction profiles + eval fixtures + pack MCP tools, registry + marketplace | **Us, uncontested.** Nothing on their side lets a customer extend the ontology |
| Licensing / hosting | Hosted cloud (`*.spectron.cloud`), SurrealDB Cloud, self-deployed server; no license or pricing published; "embedded" ≠ in-process | AGPL-3.0-or-later, self-hostable, hosted at brain.inite.ai | **Divergent.** We are inspectable and self-hostable today; their terms are unknown — watch this |

## 3. Threat assessment

**The vendor is moving up-stack over our primitives.** Everything Spectron
markets — tri-temporal beliefs, supersession, provenance, hybrid retrieval on
one engine — is built from the same SurrealDB features we build from. Risks,
ranked:

1. **Distribution collision at our named consumers.** Their integrations
   page lists `spectron-hermes` (Python) and `@surrealdb/spectron-openclaw`
   (TypeScript) — adapters for the same agent runtimes we are integrating
   brain into. They are contesting the exact sockets we planned to fill.
2. **Marketing asymmetry.** "Tri-temporal", "Accuracy Promise", "Eight
   Pillars" are better names than ours for capabilities we largely share.
   Buyers who cannot run evals will compare vocabularies, not systems.
3. **Engine-roadmap gravity.** SurrealDB's engine priorities (MVCC
   time-travel, HNSW, graph ops) will now be tuned to their memory product's
   query shapes. Mostly this benefits us (we ride the same features), but
   regressions and de-prioritizations will be resolved in their product's
   favor; our history already includes version-pin gotchas (3.1.5→3.2.1
   index breakage).
4. **License risk on the substrate.** SurrealDB's BSL-style licensing
   restricts offering the *database* as a service; a vendor with a competing
   product has an incentive to tighten terms. Keep the storage-adapter seam
   honest; our SurrealQL usage is already catalogued (migrations, stored-fn
   audit).
5. **Credibility spillover.** If their unbenchmarked "Accuracy Promise"
   disappoints users, it can sour the category for everyone shipping
   "memory with provenance" language — including us.

**Defensible differentiation** (things they cannot copy cheaply):
measured accuracy under a strict published protocol (their docs have zero
numbers; our held-out results and recorded nulls are years of harness work);
GDPR-grade hard delete as a tested cascade; native multi-tenancy economics;
domain packs as an ontology *standard* with signing + marketplace; the
episode substrate + raw-replay (their own four-tier ladder tops out at
"broader retrieval", not raw-transcript escalation — and raw-replay is our
single largest measured ablation at −22pp when absent); verifier-gated
synthesis and abstention (their promise is "you can audit it"; ours is "it
refuses to lie and we measured how often").

## 4. Worth stealing

1. **AGENTS.md for agents** *(shipped with this analysis — see root
   [AGENTS.md](../../AGENTS.md))*: an imperative, mistake-oriented guide
   written for the consuming agent, not the human integrator. Cheap, high
   distribution value.
2. **Response-reuse tier (their T2) → fovea cascade.** An entity-aware
   answer cache: store `synthesize` outputs keyed to their supporting
   factIds; serve on repeat questions while every cited fact is still
   active; invalidate via the `memory_diff` window. This is a genuinely new
   rung for our L0–L3 ladder ([§8](memory-research-2026-08.md#8-foveated-memory--the-resolution-cascade-program-e-fovea-2026-08-17))
   and is cheap to prototype on the eval stand.
3. **Confidence-gated escalation.** Their "<0.40 → escalate a tier" is the
   missing wiring for our L3: verifier-unsupported / low-coverage should go
   UP a layer (raw session → large-context call), not just abstain. Already
   sketched as the L3 escalation lane; their ladder confirms the product
   shape.
4. **Char-span provenance.** `source.span` offsets enabling "jump to quote".
   We store episode indices per fact (V13 per-turn timestamps +
   episode_indices); adding character spans to the provenance payload is a
   small migration + extractor change with real UI payoff.
5. **Terminology.** "No fact-bearing record is anonymous" (our invariant
   too — say it this way), "closed in time, not erased" (retraction docs),
   a named tier ladder for the fovea program.
6. **Hierarchical scope tags (OR-of-ANDs)** as the generalization path for
   `userId` when consumers need org/project/team scoping — keep our
   fail-closed default, which they lack.
7. **`install-mcp`-style one-command installer** for `@inite/brain-mcp` —
   add to the [distribution playbook](../distribution.md).

Concrete next steps: (a) response-reuse cache prototype behind a default-off
flag, measured as a cost tier on the LME stand; (b) L3 escalation lane build
(already the top fovea candidate); (c) spans migration draft; (d) AGENTS.md
shipped now; (e) a public one-pager contrasting our published protocol with
unbenchmarked "promises" — without naming names.
