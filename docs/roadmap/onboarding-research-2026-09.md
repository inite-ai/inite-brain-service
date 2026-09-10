# Onboarding research — how a harness connects Brain as memory (2026-09-10)

Question asked: *is our onboarding simple, obvious and complete for any
harness, or is there work left — and what are the current trends for
wiring external memory into agents?*

Answer in one line: **the transport layer is in good shape and matches
where the ecosystem is going; the path a human walks from "I found
brain" to "my agent remembers" is broken in at least four places, and we
are absent from every place where that path starts.**

Method: read the shipped onboarding surface (README, `docs/`,
`brain-landing/content/docs`, `skills/`, `clients/brain-mcp`,
`server.json`, the app's Keys screen), probed production with curl, and
searched the 2026 ecosystem for how external memory is being attached
today. Every defect below has evidence attached — a command output or a
`file:line`.

---

## 1. What already works

| Surface | State |
|---|---|
| Remote MCP, Streamable HTTP, **stateless** | `src/mcp/mcp.controller.ts:59` — one server per request, no session id. This is exactly the direction the 2026-07-28 MCP revision took (protocol-level sessions removed), so we are ahead, not behind. |
| stdio bridge for header-less harnesses | `clients/brain-mcp` — transparent tool + resource passthrough, reverse sampling bridge. |
| Unauthenticated MCP health probe | `GET /mcp/:companyId/health` returns `{ok, version, tools[], embedder}` before any key is pasted. Verified live. Very few memory servers ship this; keep it. |
| Skills in the open `SKILL.md` format | 6 skills, bundle `0.4.0`, published tarball matches the repo. The format became a cross-agent standard in 2026 (agentskills.io; 16+ tools). |
| Auth architecture ready for OAuth | JWKS verification + RFC 7662 introspection + RFC 9728 protected-resource metadata (`src/auth/credential-resolver.service.ts`, `src/auth/protected-resource.controller.ts`). The pieces exist. |
| Scope matrix documented | `content/docs/en/mcp/setup.mdx:145` — honest about 19 / 21 / 30 tools per scope. |
| `server.json` ready to publish | Repo root, schema-valid, remotes + headers declared. |

---

## 2. Verified defects

### P0-1 — the OAuth discovery chain dead-ends in production

A 401 correctly advertises where to self-onboard, and the advertised
document 404s into the marketing site:

```
$ curl -i -X POST https://brain.inite.ai/mcp/co_demo -d '{...}'
HTTP/2 401
www-authenticate: Bearer resource_metadata="https://brain.inite.ai/.well-known/oauth-protected-resource"

$ curl -o /dev/null -w '%{http_code}' https://brain.inite.ai/.well-known/oauth-protected-resource
404          # and the body is the Next.js landing HTML
```

The controller exists (`src/auth/protected-resource.controller.ts:19`);
the edge simply never routes `/.well-known/*` to the API. Any MCP client
that follows RFC 9728 — which is now the mandated discovery path for
remote servers — walks off a cliff. `/.well-known/agent-card.json` and
`/llms.txt` return 200, so this is a routing gap, not a deploy failure.

### P0-2 — there is no self-serve way to get a key

- README:180 tells the reader to *"Get an API key and its company ID
  from the web app"* and links `/en/app/keys`.
- That page (`app/[lang]/app/keys/page.tsx:43`) renders a static config
  block with `brain_YOUR_API_KEY` placeholders and ends with *"Need a new
  key or per-user scopes? Contact your workspace admin."*
- `companyId` never appears in any user-facing component — only in admin
  panels.
- The backend matches: `src/admin/admin-keys.controller.ts` exposes
  `GET` only. No create, no rotate, no reveal.

So the documented first step of the hosted product does not exist. Every
hosted signup terminates in a human handoff, and the copy-paste snippets
we show can never be pasted as-is because the two values that matter are
placeholders.

### P0-3 — the npm connector we document is not the npm connector we publish

```
$ curl -s https://registry.npmjs.org/@inite/brain-mcp | jq '.["dist-tags"], (.versions|keys)'
{"latest": "0.1.0"}   ["0.1.0"]      # published 2026-06-23
```

The repo ships `0.2.0` (`clients/brain-mcp/package.json`), and the docs
describe 0.2 behaviour explicitly: *"as of v0.2, `tools/list` /
`tools/call` AND the resource surface … are forwarded"*
(`setup.mdx:107`). Anyone following the documented
`npx -y @inite/brain-mcp` gets 0.1.0 — no resource forwarding, no
sampling bridge. The docs describe software the user cannot install.

### P1-4 — Claude Code, the most common harness, is undocumented

`content/docs/en/mcp/setup.mdx` covers Claude Desktop, Cursor, Goose,
n8n, Hermes and openclaw. Grepping the whole doc tree for `claude mcp
add` returns nothing. Neither does Codex CLI, Gemini CLI, VS Code /
Copilot, Windsurf, Cline, Zed, opencode, or any framework SDK
(LangGraph, Vercel AI SDK, OpenAI Agents SDK). `skills/brain-mcp-setup`
has the same six-client list.

We cover the harnesses of 2025 and miss most of the harnesses of 2026.

### P1-5 — `companyId` in the URL blocks every one-click connector

`/mcp` without a tenant is a 404 (verified); the tenant lives in the
path and must equal the key's tenant
(`src/mcp/mcp.controller.ts:52`). One-click connector UIs (Claude custom
connectors, ChatGPT connectors) ask the user for *one URL* and run OAuth
from there — the user has no tenant id at that moment, and after OAuth
the tenant is knowable from the token anyway. Until `/mcp` resolves the
tenant from the credential, we cannot be a one-click connector at all.

### P1-6 — skills install only into Claude

`skills/install.sh` writes to `~/.claude/skills` or
`$PWD/.claude/skills`, nothing else. But `SKILL.md` is now a
cross-agent standard, and the other agents look elsewhere:
`.agents/skills/` (vendor-neutral, read by Codex and others),
`~/.codex/skills/`, `~/.gemini/skills/`, `.cursor/skills/`. Our
one-liner — the best onboarding asset we have — serves one harness out
of a dozen that could use it unchanged.

### P2-7 — the installer reports a success that never happened

`install.sh` POSTs to `https://brain.inite.ai/mcp/install-probe`, then
prints `-> Notified dashboard.` unconditionally (`curl … || true`). No
such endpoint exists (`install-probe` appears nowhere in `src/`), and
`/mcp/install-probe` would 401 anyway. There is also no dashboard
checklist for it to flip. Dead telemetry plus a false claim to the user.

### P2-8 — first write is far heavier than the category norm

The quickstart's first call is `POST /v1/ingest/fact` with
`entityRef.vertical`, `predicate`, `object`, `validFrom`,
`source.messageId` — five domain concepts before the first success. The
category norm is `add("text", user_id=…)`. We *have* the equivalent
(`POST /v1/ingest/mention`, LLM extraction —
`src/ingest/ingest.controller.ts:28`) and it appears in neither the
README quickstart nor the landing Quickstart tabs.

### P2-9 — tool-surface size fights the 2026 context-budget trend

A read-only key exposes **19 tools** (verified live), up to 30 with
write + admin + packs. Description literals across `src/mcp/*.ts` alone
are ~11k characters (~2.8k tokens); with JSON schemas the real
`tools/list` cost lands in the 8-15k token range — 4-8% of a 200k window
consumed before the user types anything. The whole ecosystem moved the
other way this year (tool search, progressive disclosure, code mode).
Nothing in our product lets an operator say "give me the five tools I
actually use".

### P2-10 — the registry entry is three months stale, the lists are empty

Brain **is** in the official MCP Registry — `io.github.inite-ai/inite-brain-service`.
The live record is **v0.1.0, published 2026-06-24**, against a
`server.json` that now says 2.2.0, and its `_meta` claimed 18 tools when
a read-only key alone sees 19. (Correction to a first pass of this
research, which read a `?search=inite` miss as absence: the registry's
search matches the full name, so `inite-brain` finds it and `inite`
does not.)

The rest of `docs/distribution.md` is unchecked, and at least the top
target is genuinely absent: `punkpeye/awesome-mcp-servers` — the highest
traffic catalogue in the playbook — has no brain row as of 2026-09-10,
verified against the live README.

### P2-11 — small drift that costs debugging time

`GET /mcp/:id/health` reports `version: 0.3.0` (the MCP server version,
`MCP_SERVER_VERSION`) while `/health` reports `2.2.0` (the product). Two
different numbers for "which brain am I talking to" is a support ticket
waiting to happen — label it (`mcpVersion` + `serviceVersion`).

---

## 3. How external memory is actually being attached in 2026

Eight patterns are in play. We support two of them well.

| # | Pattern | What it is | Us |
|---|---|---|---|
| 1 | **Remote MCP + OAuth one-click** | Paste a URL, host runs OAuth 2.1 + PKCE, DCR (now sliding toward Client ID Metadata Documents per the 2026-07-28 revision). This is how Claude and ChatGPT accept third-party connectors. | Half. Server-side verification exists, discovery is 404, tenant-in-path blocks it. |
| 2 | **Remote MCP + static bearer** | Config file per harness. | ✅ Works, documented for six clients. |
| 3 | **stdio bridge** for harnesses that can't send headers | | ✅ Built — but the published npm build is a version behind. |
| 4 | **Skills (`SKILL.md`) over a thin tool surface** | The standard went cross-agent this year; skills carry the *how to use it* so the tool schemas can stay small. | ✅ Best-in-class content, ❌ Claude-only installer. |
| 5 | **Plugin / marketplace bundles** | One `/plugin marketplace add …` installs skills + `.mcp.json` + hooks + commands together. The dominant Claude Code distribution unit in 2026. | ❌ No `.claude-plugin/` anywhere in the repo. |
| 6 | **Lifecycle hooks for passive capture** | `SessionStart` injects recall, `PreCompact` / `SessionEnd` / `Stop` write the session back. This is what makes memory *actually* persist instead of depending on the model choosing to call `record_fact`. | ❌ Not a single hook recipe in docs or skills. |
| 7 | **Anthropic memory tool + context editing** (`memory_20250818`) | Client-side file-shaped memory (`view/create/str_replace/insert/delete/rename`) that the developer backs with their own storage; paired with context editing it reports large token savings on long runs. Whoever supplies the backend owns the memory. | ❌ No adapter. This is the clearest open lane for us. |
| 8 | **Framework adapters** | The fastest-growing surface in the category — the leading vendor documents 21 framework integrations. LangGraph store, Vercel AI SDK, OpenAI Agents SDK, Mastra, Pydantic AI. | ❌ None. We ship `fetch` snippets and no SDK package. |

Two secondary trends worth noting:

- **ChatGPT connectors** need OAuth + DCR, and the deep-research variant
  needs exactly two tools named `search` and `fetch`. A thin
  ChatGPT-shaped facade over `search_knowledge` / `get_fact` would open
  that channel without touching our tool design.
- **One-click install badges** (`cursor://…/mcp/install`,
  `vscode://mcp/install`) are now standard README furniture for MCP
  servers. Cheap, and we have none.

---

## 4. Harness coverage matrix

| Harness | Path that would work | Documented? |
|---|---|---|
| Claude Code | `claude mcp add --transport http` / project `.mcp.json` | ❌ |
| Claude Desktop | stdio connector or remote connector | ✅ |
| Claude.ai (web/mobile) custom connector | remote MCP + OAuth | ❌ blocked by P0-1 / P1-5 |
| ChatGPT (dev mode / connectors) | remote MCP + OAuth (+ `search`/`fetch` for deep research) | ❌ |
| Cursor | `.cursor/mcp.json` | ✅ |
| VS Code / Copilot | `.vscode/mcp.json` | ❌ |
| Codex CLI | `~/.codex/config.toml` | ❌ |
| Gemini CLI | `~/.gemini/settings.json` | ❌ |
| Goose v2 | `config.yaml` | ✅ |
| Windsurf / Cline / Zed / opencode | per-client MCP config | ❌ |
| n8n | MCP Client node | ✅ |
| Hermes | `mcp_servers` | ✅ |
| openclaw / Goose 1.x | stdio connector | ✅ |
| LangGraph / Vercel AI SDK / OpenAI Agents SDK / Mastra | adapter or raw REST | ❌ |

*(Exact config syntax per client must be verified against current
upstream docs when the page is written — this table is about coverage,
not about the snippets.)*

---

## 5. Recommended work

### Wave 0 — truthfulness (hours, no design decisions)

*Shipped in the PR that carries this document, except where noted.*

1. ✅ Route `/.well-known/oauth-protected-resource` on `brain.inite.ai`
   to the API so RFC 9728 discovery resolves — the Traefik rule is
   generated by `deploy-brain.yml`, so the fix lives there, and the
   post-deploy smoke now asserts the JSON body (a 200 from the landing
   app would otherwise pass). The service additionally answers the
   path-suffixed form for `/mcp/<companyId>`. **P0-1.**
2. ⬜ Publish `@inite/brain-mcp@0.2.0` to npm — needs a logged-in npm
   account, so it is the one Wave 0 item this PR cannot carry. **P0-3.**
3. ✅ Deleted the `install-probe` ping and the "Notified dashboard" line
   it printed unconditionally; the flag returns when the checklist it
   was meant to tick exists. **P2-7.**
4. ✅ README and both setup pages now say keys are operator-issued
   instead of pointing at a screen that cannot issue one. **P0-2
   (interim — the real fix is Wave 1 item 7).**
5. ✅ MCP health reports `serviceVersion` alongside the MCP server's own
   `version`. **P2-11.**
6. ◐ Re-published `server.json` to the MCP Registry — **v2.2.0 is live
   and flagged latest** as of 2026-09-10, replacing the v0.1.0 record
   from June. The awesome-list PRs in the playbook are still unfiled.
   **P2-10.**

### Wave 1 — the path from signup to first recall (days)

7. ✅ **Self-serve keys.** Shipped: brain issues, verifies and revokes
   its own keys from a system-DB store (migration 0141), exposed as
   `POST /v1/keys` / `GET /v1/keys` / `POST /v1/keys/{id}/revoke` and as
   a real Keys screen — the tenant's `companyId`, its MCP URL, the key
   shown once, and *personalised* copy-paste configuration (no
   placeholders) for Claude Code, Claude Desktop, Cursor, VS Code, Codex
   CLI, Goose and curl. A key is never wider than the credential that
   minted it, and the same endpoints work self-hosted, where the env-var
   key becomes a bootstrap rather than the only way in.
   Gemini CLI and n8n snippets are deliberately absent until their
   current config shape is verified — a wrong snippet costs more than a
   missing one.
8. **`/mcp` without a tenant path** — resolve tenancy from the
   credential, keep `/mcp/:companyId` as the explicit form. Unblocks
   every one-click connector surface. **P1-5.**
9. **Multi-target installer**: `install.sh --target claude|codex|gemini|
   cursor|agents|all`, defaulting to autodetect + the vendor-neutral
   `.agents/skills/`. **P1-6.**
10. **Claude Code plugin** — `.claude-plugin/marketplace.json` +
    `plugin.json` bundling the six skills, `.mcp.json`, and hook
    recipes, so the whole integration is one command.
11. **Hook recipes** (pattern 6): `SessionStart` → `memory_diff` +
    `search_knowledge` injection; `PreCompact` / `SessionEnd` →
    `record_fact` / `ingest_document`. Ship them in the plugin and as a
    docs page. Without this, "the agent has memory" depends on the model
    remembering to write, which is the number-one reason memory
    integrations feel dead.
12. **A two-line quickstart** built on `/v1/ingest/mention` (text +
    userId in, extraction handled) with the typed `ingest/fact` path
    presented as the precision route, not the first step. **P2-8.**
13. Install badges / deeplinks in the README.

### Wave 2 — new channels (weeks)

14. **OAuth one-click end to end**: DCR (and/or CIMD) on
    `auth.inite.ai`, consent screen, scope mapping to `brain:*`,
    tested against Claude custom connectors. Depends on 1 + 8.
15. **Tool budget control**: a `core` profile (≈5 tools:
    `search_knowledge`, `synthesize`, `record_fact`, `memory_diff`,
    `get_entity_timeline`) as the default, full surface opt-in, and/or
    a tool-search meta-tool. Pair it with the skills, which already
    carry the knowledge the schemas are currently paying for. **P2-9.**
16. **ChatGPT connector facade**: `search` + `fetch` tools with the
    shapes that product expects.
17. **Anthropic memory-tool adapter** (`@inite/brain-memory-tool`) —
    implement the `memory_20250818` command surface over brain, so any
    team already using the memory tool can swap the filesystem backend
    for a bitemporal graph without touching their agent loop. Strategic:
    it is the one pattern where our differentiator (temporal history,
    conflicts, provenance) is invisible to integrate and obvious in use.
18. **Framework adapters + a real SDK package** (`@inite/brain` for TS,
    a Python client): LangGraph store, Vercel AI SDK, OpenAI Agents SDK.

### Deliberately not recommended

- Chasing every harness with a hand-written page. Once 7 + 8 exist, a
  generated snippet per harness is a data file, not a doc-writing
  project.
- A second protocol surface (A2A, custom REST memory API) before the
  MCP path is clean end to end.

---

## 6. Decided (2026-09-10)

**The hosted service is the product; self-host is the escape hatch** —
the mem0 shape. That settles the biggest question this research raised
and makes **item 7 (self-serve keys) the P0 of Wave 1**: a hosted-first
product whose key issuance runs through a human is a funnel with a
manual valve in the middle of it. Until that ships, the docs say plainly
that keys are operator-issued rather than pointing at a screen that
cannot issue one (done in Wave 0).

Still open, and cheaper than they look:

- **A demo / sandbox tenant.** A read-only seeded tenant with a public
  key gets a stranger to "the agent answered from memory" in a minute
  and needs no key CRUD at all. It is the fastest available fix for
  time-to-value and it survives the arrival of self-serve keys.
- **Tool surface**: is a 5-tool default acceptable as the *hosted*
  default, with the full 30 behind a flag? It trades discoverability of
  advanced capability for a much cheaper context footprint.

---

## Sources

Ecosystem trends were checked against public 2026 material on: the MCP
2026-07-28 revision (sessionless transport, CIMD over DCR), Claude and
ChatGPT custom-connector requirements, ChatGPT deep-research
`search`/`fetch` contract, Anthropic's memory tool + context editing,
Claude Code plugins/marketplaces, the `SKILL.md` open standard and its
per-agent install paths, MCP context-bloat / progressive-disclosure
work, and the memory-vendor landscape (mem0 / Zep / Letta / Cognee /
Supermemory) integration surfaces.
