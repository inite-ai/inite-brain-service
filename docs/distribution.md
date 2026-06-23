# Distribution playbook — getting brain on the MCP map

How to land `inite-brain-service` in the directories and awesome lists that MCP clients + agent builders actually browse. Order matters: the official MCP Registry feeds PulseMCP / Glama / mcp.so automatically, so publish there FIRST, then do the awesome-list PRs.

This file is the source of truth — keep the row text and form fields here so the next push (new tool surface, new version) needs only a search-and-replace.

## Status (update on every push)

| Target | Status | URL when live |
|---|---|---|
| Official MCP Registry | ⬜ not submitted | https://registry.modelcontextprotocol.io/v0/servers?search=inite-brain |
| PulseMCP | ⬜ auto (after registry) | https://www.pulsemcp.com/servers/inite-brain |
| punkpeye/awesome-mcp-servers | ⬜ not submitted | — |
| topoteretes/awesome-ai-memory | ⬜ not submitted | — |
| surrealdb/awesome-surreal | ⬜ not submitted | — |
| mcpservers.org form | ⬜ not submitted | — |
| webfuse-com/awesome-claude | ⬜ not submitted | — |
| appcypher/awesome-mcp-servers | ⬜ not submitted | — |
| IAAR-Shanghai/Awesome-AI-Memory | ⬜ not submitted | — |
| kyrolabs/awesome-agents | ⬜ not submitted | — |
| tensorchord/Awesome-LLMOps | ⬜ not submitted | — |
| DEEP-PolyU/Awesome-GraphRAG | ⬜ not submitted | — |
| jxzhangjhu/Awesome-LLM-RAG | ⬜ not submitted | — |
| Danielskry/Awesome-RAG | ⬜ not submitted | — |
| Jenqyang/Awesome-AI-Agents | ⬜ not submitted | — |
| kaushikb11/awesome-llm-agents | ⬜ not submitted | — |
| totogo/awesome-knowledge-graph | ⬜ not submitted | — |

---

## 1. Official MCP Registry — publish `server.json`

The canonical machine-readable registry that every MCP client (Claude Desktop / Cursor / Aider / Goose / Continue) ingests. PulseMCP / Glama / mcp.so auto-sync from it weekly. **Do this first.**

`server.json` is committed at the **repo root** (see `/server.json`). Bump `version` on every meaningful surface change before re-publishing.

### Publish flow

```bash
# Pick the right archive for your OS/arch
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
  | tar xz

./mcp-publisher login github   # opens GitHub OAuth in browser
./mcp-publisher publish        # validates server.json + claims the io.github.inite-ai/* namespace
```

The `io.github.inite-ai/...` namespace is claimed via GitHub OAuth on the `inite-ai` org. If you'd rather use a vendor namespace (`ai.inite/*`), set up a DNS-TXT record on `inite.ai` per the publisher CLI prompt — costs nothing but ties the name to the domain.

### Updating

Bump `version` in `server.json`, re-run `./mcp-publisher publish`. Old versions stay; clients pull the latest.

---

## 2. PulseMCP — auto-ingest (no action)

PulseMCP ingests the Registry weekly. Brain should appear at `https://www.pulsemcp.com/servers/<slug>` within ~7 days of registry publish.

If it's been 10+ days and brain isn't there, email `hello@pulsemcp.com` with `https://registry.modelcontextprotocol.io/v0/servers?search=inite-brain` and `https://github.com/inite-ai/inite-brain-service`. They verify informally — no domain/TXT flow exists.

---

## 3. `punkpeye/awesome-mcp-servers`

The single highest-traffic MCP catalogue (89k+ stars, daily commits). Glama auto-adds a score badge after the PR merges.

### Where

Section: **🧠 Knowledge & Memory** (existing heading, alphabetically by `owner/repo`).
File: `README.md`.
Brain owner `inite-ai` → insert between rows starting with `h...` and `j...`.

### Row to paste

```
- [inite-ai/inite-brain-service](https://github.com/inite-ai/inite-brain-service) 📇 ☁️ - "Open-source memory layer for LLM agents — bitemporal knowledge graph (SurrealDB) with facts, episodes, procedural tiers; hybrid vector + BM25 + multi-hop retrieval; GDPR-grade forget_entity; LoCoMo-benchmarked."
```

### Badge legend

- 📇 — TypeScript / JavaScript codebase (brain is NestJS / TS)
- ☁️ — Cloud Service (hosted)
- 🏠 — Local Service (add this badge if/when you ship a self-host Docker image people install themselves)
- 🍎 🪟 🐧 — OS support (skip until self-host is shipped)

Don't fabricate a Glama score badge — it's added automatically after listing.

### PR title

```
Add inite-brain-service to Knowledge & Memory
```

### PR body

```
Adds inite-brain-service — open-source (AGPL-3.0) bitemporal memory layer
for LLM agents. MCP server (Streamable HTTP) exposing 18 tools across
read/write/admin scopes.

Distinct from existing entries: bitemporal (valid-time + transaction-
time both modelled), conflict resolver with supersede/competing/revive
semantics, three memory tiers (facts/episodes/procedural), and a
GDPR-grade forget_entity tool. LoCoMo-benchmarked.

Registry entry: https://registry.modelcontextprotocol.io/v0/servers?search=inite-brain
```

---

## 4. `topoteretes/awesome-ai-memory`

Direct catalogue for the Mem0 / Zep / MemGPT / Letta cohort — brain's immediate peers.

### Where

Section: the Memory Tool table (rows cluster by category, not strictly alphabetical — add near other Memory Tool rows).
File: `README.md`.

### Column headers (verbatim)

```
| Name | Description | URL | Open / Close | GitHub URL | Category | Storage |
```

### Row to paste

```
| Inite Brain | Open-source memory layer for LLM agents — bitemporal knowledge graph with facts/episodes/procedural tiers, hybrid retrieval, multi-hop planner, GDPR forget. LoCoMo-benchmarked. | https://brain.inite.ai | Managed, Open source | https://github.com/inite-ai/inite-brain-service | Memory Tool | Graph, Vector |
```

---

## 5. `surrealdb/awesome-surreal`

DB-vendor list. Bonus: SurrealDB team often amplifies PRs from projects built on top.

### Where

Section: Applications / Projects (depending on the README's current structure).
File: `README.md`.
Alphabetical by title — "Inite Brain" sits between `H...` and `O...` entries.

### Row to paste

```
[Inite Brain](https://github.com/inite-ai/inite-brain-service) - Open-source memory layer for LLM agents built on SurrealDB. Bitemporal knowledge graph with facts/episodes/procedural tiers, hybrid vector + BM25 + multi-hop retrieval, conflict resolution, GDPR forget. MCP server, Streamable HTTP, AGPL-3.0.
```

---

## 6. `mcpservers.org` form (feeds `wong2/awesome-mcp-servers`)

`wong2/awesome-mcp-servers` does NOT take PRs — they ingest from the form.

URL: https://mcpservers.org/submit

| Field | Value |
|---|---|
| Server Name | `Inite Brain` |
| Short Description | `Open-source memory layer for LLM agents — bitemporal knowledge graph with facts/episodes/procedural tiers, hybrid retrieval, GDPR forget. LoCoMo-benchmarked.` |
| Link | `https://github.com/inite-ai/inite-brain-service` |
| Category | `Memory` |
| Contact Email | `<your contact>` |
| Premium Submit | unchecked |

---

## 7. `webfuse-com/awesome-claude`

Section: **Claude Code & Model Context Protocol (MCP)**.

```
- [inite-brain-service](https://github.com/inite-ai/inite-brain-service) — open-source memory layer for Claude (and any other MCP client). Bitemporal knowledge graph, 18 tools, three memory tiers (facts/episodes/procedural), conflict resolution, GDPR forget. AGPL-3.0.
```

Note: 165+ open PRs on this repo as of 2026-06 — maintainer is slow. File and forget.

---

## 8. `appcypher/awesome-mcp-servers`

Section: probably **🤝 AI Services** or **🗄️ Databases** — no dedicated memory section. Pick the closest, link from the PR body to the existing Mem0/Zep entries (if any) for reference.

Same row format as punkpeye.

---

## 9. `IAAR-Shanghai/Awesome-AI-Memory`

Section: **"Systems and Open Sources"** (the engineering-implementations section, distinct from papers).

Format depends on the section — most rows are bullet lists with a one-line description. Use:

```
- [Inite Brain](https://github.com/inite-ai/inite-brain-service) — bitemporal knowledge graph memory layer (AGPL-3.0). Facts, episodes, procedural tiers; hybrid retrieval; multi-hop planner-LLM with claim verifier; conflict resolution; GDPR forget. LoCoMo-benchmarked.
```

---

## 10. Adjacent ecosystem lists (Week 3 batch)

Same row format as #9 unless a specific list uses a table. Each PR is ~5 minutes — copy-paste-merge.

- **kyrolabs/awesome-agents** — section: Memory / Memory tools. Mem0 is already there.
- **tensorchord/Awesome-LLMOps** — section: Memory / Agent infra.
- **DEEP-PolyU/Awesome-GraphRAG** — section: Open-source projects. Position brain as "bitemporal GraphRAG with conflict resolution".
- **jxzhangjhu/Awesome-LLM-RAG** — section: Tools / Open-source. Emphasise multi-hop + verifier.
- **Danielskry/Awesome-RAG** — section: Frameworks / Open-source.
- **Jenqyang/Awesome-AI-Agents** — section: Memory-augmented agents.
- **kaushikb11/awesome-llm-agents** — section: Frameworks / Memory.
- **totogo/awesome-knowledge-graph** — section: Tools. Emphasise bitemporal + conflict resolution (rare in KG land).

---

## What to skip (and why)

- **modelcontextprotocol/servers** — community section removed; registry replaces it.
- **awesome-selfhosted** — needs end-user web UI + Docker compose. Revisit when brain ships an admin UI.
- **awesome-langchain** — needs a LangChain adapter (≈50 lines if you want to invest).
- **awesome-vector-database** — wrong category; brain isn't a vector DB.
- **e2b-dev/awesome-ai-agents**, **BrambleXu/knowledge-graph-learning** — dead (16mo+ and 3.5yr+ stale).
- **awesome-cursor / awesome-aider / awesome-mcp-clients** — client-only lists; brain is a server.
- **best-of-mcp-servers / abordage/awesome-mcp / collabnix/awesome-mcp-lists** — auto-crawled; will pick brain up from stars once it lands elsewhere.

---

## After landing

Update the Status table at the top of this file with the live URL for each row. Add a Telegram / X teaser post per major hit (template lives in `docs/teasers.md` — create when first one ships). When you bump brain past a major version, re-publish `server.json`, re-check the top three (punkpeye / topoteretes / surrealdb) for stale descriptions, edit-PR if the row text doesn't reflect the new surface.
