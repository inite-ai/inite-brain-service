# AGENTS.md — using Brain as your memory over MCP

This guide is for AI agents (Claude Code, Cursor, openclaw, custom MCP
clients) consuming **INITE Brain** — a bitemporal, per-tenant knowledge-graph
memory service on SurrealDB. Humans: start at
[docs/getting-started.md](docs/getting-started.md) instead.

## Connect

Brain speaks MCP over **Streamable HTTP**, one endpoint per tenant:

```
POST https://brain.inite.ai/mcp/<companyId>
Authorization: Bearer brain_<api-key>
```

Harnesses with native remote-MCP support connect by URL + header. Harnesses
that can only spawn stdio servers use the first-party shim
[`@inite/brain-mcp`](clients/brain-mcp/README.md):

```json
{ "command": "npx", "args": ["-y", "@inite/brain-mcp"],
  "env": { "BRAIN_API_KEY": "brain_…", "BRAIN_COMPANY_ID": "…" } }
```

Self-hosted: add `BRAIN_BASE_URL` (or `BRAIN_MCP_URL`). The shim (v0.2) is a
transparent passthrough for tools AND resources (`resources/list`,
`resources/templates/list`, `resources/read`), and bridges sampling in
reverse — brain's `sampling/createMessage` reaches YOUR model, falling back
to a server-side template when your harness doesn't advertise sampling.
Auth, tenancy, scopes, and PII fencing are enforced server-side from the
key. Key scopes decide what `tools/list` returns: `brain:read` → read
surface; `brain:write` adds mutations; `brain:admin` adds GDPR forget.
Two further scopes exist but are hosting-operator-only (granted via env-key
config, never mintable through tokens): `brain:read_media` (media/biometric
evidence — stricter than `brain:read_pii`, not implied by it) and
`brain:platform_admin` (cross-tenant operator authority).

## Tool surface

Read (with `brain:read`):

| Tool | One-line semantics |
|---|---|
| `search_knowledge` | Semantic search over the graph; entities + top facts; `asOf` for "what did we know on X" |
| `search_multi_hop` | Planner-LLM decomposes into ≤5 anchored hops; returns an auditable evidence chain (`finalEntityIds` + `supportingFactIds`); `synthesize=true` for a grounded answer |
| `graph_retrieve` | Graph-first retrieval around named entities (1-hop neighbourhood); use when you already know WHICH entities |
| `synthesize` | Hybrid search → citation-bearing answer (each claim ends `[factId]`) → verifier LLM; guardrails `strict`/`lenient`/`off` |
| `memory_diff` | Everything learned / retracted / superseded / forgotten between two ISO cursors `[from, to)` — "what changed since last conversation?" |
| `get_entity_profile` | One entity: canonical name, type, externalRefs, active facts |
| `get_entity_timeline` | Chronological audit of all facts about an entity, retracted included |
| `summarize_entity` | One-line briefing; `styleHint='client_llm'` delegates wording to YOUR model via MCP sampling |
| `get_competing_facts` | Unresolved same-predicate disagreements (COMPETING status) for an entity |
| `detect_contradiction` | Dry-run the conflict resolver: "if I recorded this fact, what would happen?" (`INSERTED`/`SUPERSEDED`/`COMPETING`/`REJECTED`) |
| `find_related_entities` | Entities connected via graph edges, with bitemporal `asOf` cutoff |
| `match_procedure`, `list_procedures` | Procedural memory: reusable how-to recipes |
| `search_communities`, `list_communities`, `find_entity_communities` | Graph community summaries (thematic clusters) |
| `why`, `recall_decisions` | Code-memory: why code is the way it is; past recorded decisions |
| `get_source_reputation` | Learned trust profile of a source vertical |
| `get_fact` | One fact as stored: statement, validity, source attribution, lifecycle (`retracted: true` still resolves), and `groundingStatus` (`grounded`/`ungrounded`; absent = legacy row). Registered when the server runs `FACTS_API_ENABLED` |
| `get_fact_provenance` | Why a fact is remembered: the verbatim grounding turns (with char-span quotes when stamped); plus `derivedFacts`/`closure`/`supportEdges` on servers running the closure/support-graph read flags. Same `FACTS_API_ENABLED` gate |

MCP resources (droppable into context without a tool call):
`brain://entity/<id>` (profile) and `brain://entity/<id>/timeline`.

Write (adds with `brain:write`): `record_fact` (accepts `conversationId` +
`evidence[]` — see grounding below), `link_entities`, `retract_fact`,
`record_procedure`, `retire_procedure`, `record_feedback`,
`ingest_document` (Source→Indexer→Candidates pipeline; prefer over
`record_fact` for anything longer than one claim; accepts
`toolObservationRef: tool_observation:<id>` to close the tool result →
document → fact provenance loop under `TOOL_OBSERVATIONS_ENABLED`),
`record_decision`.

Admin (adds with `brain:admin`): `forget_entity` — GDPR hard-delete with a
synchronous cascade and tombstones.

## Memory semantics you must know

- **Facts vs episodes.** Brain ingests raw conversation/document *episodes*
  and derives typed *facts* (entity, predicate, object, confidence) from
  them. Reads serve facts; provenance points back at the raw source.
- **Bitemporal by default.** Every fact carries valid time
  (`validFrom`/`validUntil` — when it held in reality) and knowledge time
  (when brain learned/retracted it). Default reads = "actual now". Pass
  `asOf` to ask "what did we believe at T" — it is knowledge-time, not
  valid-time. See [docs/bitemporal-semantics.md](docs/bitemporal-semantics.md).
- **Conflicts are explicit.** A new fact meeting an overlapping same-predicate
  prior is auto-superseded, or parked as COMPETING when too close to call —
  never silently last-write-wins. Preflight contested writes with
  `detect_contradiction`; inspect stalemates with `get_competing_facts`.
- **Per-user scope is fail-closed.** Read/write tools accept `userId`.
  Omitting it returns tenant-global facts ONLY — a user's personal memory is
  never mixed in unless you ask for that user. Always pass `userId` when
  acting for a specific person.
- **Retraction ≠ forgetting.** `retract_fact` closes a fact in knowledge
  time — auditable, history kept, visible in timelines and `memory_diff`.
  `forget_entity` (admin, reasons incl. `gdpr_request`) is a hard delete;
  only tombstones remain. Do not use forget for "this fact is now wrong" —
  record the new fact or retract.
- **Provenance is first-class.** Every fact is attributable:
  `get_fact` / `get_fact_provenance` (and their REST twins) return the
  source chain ([docs/fact-provenance-api.md](docs/fact-provenance-api.md));
  `search_multi_hop` returns supporting fact ids; `synthesize` cites
  `[factId]` per claim and a verifier judges support.
- **Ground your writes.** `record_fact` accepts `conversationId` (the
  conversation the fact was observed in) and `evidence[]` (≤10 typed
  pointers: event/message/conversation/url/document/commit/other). Naming
  the observation marks the fact **grounded** — servers stamping
  `groundingStatus` (EVIDENCE_GROUNDING_STAMP) can exclude ungrounded
  claims from consolidation and from strict serving. A bare `record_fact`
  is permanently observation-free; always pass what you have.
- **`evidenceCitations` is a SEPARATE array from `citations`.** `synthesize`
  answers carry fact citations in `citations[]` (`c.factId`); episode- or
  fragment-grounded claims arrive in `evidenceCitations[]` (episode arm:
  `episodeId` + optional verified `span`; fragment arm: `fragmentId` +
  `assetId` + `capability` + rendered `excerpt`). Never flatten the two —
  consumers reading `factId` off an evidence citation (or vice versa) will
  corrupt their provenance handling.
- **Abstention is a feature.** `synthesize` in `strict` mode returns `null`
  rather than an unsupported answer. Treat `null` as "brain does not know",
  not as an error to retry around. Beyond the classic reasons
  (`no_results`, `low_coverage`, verifier verdicts) there are two
  evidence-plane reasons with DIFFERENT remedies: `ungrounded_evidence`
  (every cited fact is `groundingStatus='ungrounded'` — remedy: ground the
  claims, not "the memory doesn't know") and `evidence_capability_unmet`
  (a claim's predicate requires non-text evidence — visual/audio/document
  — and no cited evidence of that capability exists; remedy: attach/verify
  the media).
- **Cached answers are legitimate.** A `synthesize` response with
  `cached: true` was served from the fact-lifecycle-gated answer cache:
  citations were re-validated against live fact rows at serve time, and
  `results` is EMPTY because retrieval never ran. Do not treat the empty
  `results[]` as "no evidence".
- **Your tool calls may be observed — content-free.** Under
  `TOOL_OBSERVATIONS_ENABLED` the server records per-call observation rows
  (tool name, argument/result DIGESTS, ok flag, duration — no content
  unless the operator additionally opts into a sanitized 512-char excerpt).
  Denied calls record nothing. Reference an observation from
  `ingest_document.toolObservationRef` to link derived documents back to
  the tool result they came from.

## Common mistakes

1. Omitting `userId` and concluding a user's memory is empty (fail-closed
   scope, see above).
2. Passing `asOf` expecting valid-time filtering — it is belief-time.
3. Re-deriving "what changed" by diffing two full dumps — use `memory_diff`;
   windows are half-open, adjacent windows never double-count.
4. Recording multi-claim prose via `record_fact` — use `ingest_document` and
   let extraction + conflict resolution do the work.
5. Treating COMPETING facts as noise — they are unresolved disagreements
   awaiting adjudication; surface them to the user when relevant.

## Honesty note on eval claims

When you cite brain's memory-accuracy numbers, cite them with the protocol:
strict binary judge, own full-context baseline, paired stats, held-out split
([docs/eval-protocol.md](docs/eval-protocol.md)). Do not quote numbers from
other systems' self-reported benchmarks as comparable — most published
memory scores use lenient judges and are inflated; ours are deliberately
hard to inflate.

## More

- API reference: [docs/api.md](docs/api.md) · data model:
  [docs/data-model.md](docs/data-model.md)
- Domain packs (tenant ontology extensions, pack-declared MCP tools):
  [docs/domain-packs.md](docs/domain-packs.md),
  [docs/mcp-pack-tools.md](docs/mcp-pack-tools.md)
- Per-user rolling profile: [docs/user-profile-api.md](docs/user-profile-api.md)
- Operations & self-hosting: [docs/operations.md](docs/operations.md)

License: AGPL-3.0-or-later.
