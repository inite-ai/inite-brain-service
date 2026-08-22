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

Self-hosted: add `BRAIN_BASE_URL` (or `BRAIN_MCP_URL`). The shim is a
transparent passthrough; auth, tenancy, scopes, and PII fencing are enforced
server-side from the key. Key scopes decide what `tools/list` returns:
`brain:read` → read surface; `brain:write` adds mutations; `brain:admin`
adds GDPR forget.

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

MCP resources (droppable into context without a tool call):
`brain://entity/<id>` (profile) and `brain://entity/<id>/timeline`.

Write (adds with `brain:write`): `record_fact`, `link_entities`,
`retract_fact`, `record_procedure`, `retire_procedure`, `record_feedback`,
`ingest_document` (Source→Indexer→Candidates pipeline; prefer over
`record_fact` for anything longer than one claim), `record_decision`.

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
  `GET /v1/facts/:id` and `GET /v1/facts/:id/provenance` return the source
  chain ([docs/fact-provenance-api.md](docs/fact-provenance-api.md));
  `search_multi_hop` returns supporting fact ids; `synthesize` cites
  `[factId]` per claim and a verifier judges support.
- **Abstention is a feature.** `synthesize` in `strict` mode returns `null`
  rather than an unsupported answer. Treat `null` as "brain does not know",
  not as an error to retry around.

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
