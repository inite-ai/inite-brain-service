---
name: brain-mcp-setup
description: Walk a developer through connecting a fresh MCP client (Claude Desktop, Cursor, Goose v2, Aider, Continue.dev, n8n, or a raw @modelcontextprotocol/sdk client) to the INITE Brain service. Covers obtaining an API key, the per-tenant URL shape, config snippets per client, the scope matrix for all 14 brain tools, and the smoke test. Use when the user says "add brain MCP", "connect brain to Claude", "set up brain for Cursor", or names any MCP-capable client.
---

# brain-mcp-setup

INITE Brain ships a Streamable HTTP MCP endpoint at `/mcp/:companyId`. Each tenant has its own URL, scoped by API key. This skill walks the user from zero to "tools visible in Claude".

## What the user needs

1. A **brain API key** for their company (format `brain_<base64>`).
2. The **companyId** the key was issued for (visible at `https://brain.inite.ai/admin/keys`).
3. The **MCP URL**: `https://brain.inite.ai/mcp/<companyId>`.
4. One of: Claude Desktop, Cursor, Goose v2, Aider, Continue.dev, n8n, or a raw `@modelcontextprotocol/sdk` client.

If they don't have a key yet, point them to `https://brain.inite.ai/admin/keys` and pause. Brain refuses unsigned MCP calls — there's no anonymous mode.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "brain": {
      "url": "https://brain.inite.ai/mcp/<companyId>",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <api-key>"
      }
    }
  }
}
```

Restart Claude Desktop. The brain server should appear in the MCP panel with six tools (or four, if the key only has `brain:read`).

## Cursor

Edit `.cursor/mcp.json` in the user's workspace (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "brain": {
      "url": "https://brain.inite.ai/mcp/<companyId>",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <api-key>"
      }
    }
  }
}
```

Reload the workspace. Brain tools become available under `@brain` in the AI panel.

## Goose v2

Edit `~/.config/goose/config.yaml`:

```yaml
extensions:
  brain:
    type: streamable_http
    uri: https://brain.inite.ai/mcp/<companyId>
    headers:
      Authorization: Bearer <api-key>
    enabled: true
    bundled: false
```

`goose session start` will load brain tools. Goose v2 (released Q1 2026) ships with first-class Streamable HTTP support; if you're on a 1.x Goose, the `type` field is `stdio` only and you'll need a stdio shim — upgrade is the cleaner path.

## Aider

Aider gained MCP support in 0.95. Pass the brain URL on the command line:

```bash
aider --mcp brain.inite.ai/mcp/<companyId> \
      --mcp-header "Authorization: Bearer <api-key>"
```

Or in `~/.aider.conf.yml`:

```yaml
mcp-servers:
  brain:
    url: https://brain.inite.ai/mcp/<companyId>
    headers:
      Authorization: Bearer <api-key>
```

## Continue.dev

Edit `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: brain
    type: streamable-http
    url: https://brain.inite.ai/mcp/<companyId>
    requestOptions:
      headers:
        Authorization: Bearer <api-key>
```

Reload the editor. Tools appear in the `@` mention list.

## n8n

Use the **MCP Client** node in n8n:

- URL: `https://brain.inite.ai/mcp/<companyId>`
- Transport: HTTP (Streamable)
- Header: `Authorization: Bearer <api-key>`

Pin a credential so it's reusable across workflows.

## Raw `@modelcontextprotocol/sdk` (custom clients)

For a Node / TS client that talks Streamable HTTP directly:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://brain.inite.ai/mcp/<companyId>"),
  {
    requestInit: {
      headers: { Authorization: "Bearer <api-key>" },
    },
  }
);

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const out = await client.callTool({
  name: "search_knowledge",
  arguments: { query: "hello", limit: 1 },
});
```

The brain server is request-scoped: one McpServer per call, no long-lived session state. Streamable HTTP keeps the client → server connection alive but every tool call is independent.

## Smoke test (any client)

Once the client is connected, ask it:

> List available brain tools and call `search_knowledge` with query `"hello"` limit 1.

Expected: a tool list whose count depends on the key's scopes (see matrix below) and a `search_knowledge` call that returns an empty `hits` array on a fresh tenant (or one hit if there's seed data). If the tool call returns a 401 or 403, the API key scope is wrong — go back to `https://brain.inite.ai/admin/keys` and check the key's scopes.

## Scope matrix

| Scope | Tools unlocked |
| --- | --- |
| `brain:read` (always) | `search_knowledge`, `search_multi_hop`, `synthesize`, `memory_diff`, `get_entity_profile`, `get_entity_timeline`, `summarize_entity`, `get_competing_facts`, `detect_contradiction`, `find_related_entities`, `match_procedure`, `list_procedures`, `search_communities`, `list_communities`, `find_entity_communities` (15 tools) |
| `brain:write` | + `record_fact`, `link_entities`, `retract_fact`, `record_procedure`, `retire_procedure` (5 more = 20 total) |
| `brain:admin` | + `forget_entity` (1 more = 21 total) |
| `brain:read_pii` | unlocks `email` / `phone` / `dob` / `address` object values in read results (predicate stays visible without it; no new tool surface) |

A key with only `brain:read` will see 15 tools, not 21 — that's the security invariant, not a bug. Tell the user explicitly when their key is read-only so they don't waste time looking for `record_fact` / `forget_entity`.

The detailed taxonomy (which tool for which question) lives in the workflow skills — `brain-search`, `brain-recall`, `brain-bitemporal`, `brain-write`, `brain-conflict`.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `400: MCP path companyId (...) does not match ApiKey companyId` | URL has wrong companyId for this key | Use the companyId from the `/admin/keys` row, not from another tenant |
| `401: Unauthorized` | Key missing, expired, or wrong format | Check the `Authorization` header is `Bearer brain_…` exactly; no quotes, no extra spaces |
| `403: scope brain:write required` | The user has `brain:read` only and tried `record_fact` | Either elevate the key to `brain:write` (admin only) or drop the write call |
| Tools list empty | Client never reached brain — check the URL is HTTPS and reachable | `curl -I https://brain.inite.ai/mcp/<companyId>` should return 401 (not 404 or DNS error) |
| Cursor / Claude don't see tools after editing config | Client cache | Quit fully (not just close window) and reopen |

## After setup

Once connected, point the user at the workflow skills:

- `brain-search` — finding facts and entities
- `brain-recall` — pulling one entity's full picture (profile + timeline + summarize + competing + related)
- `brain-bitemporal` — temporal questions, including the `memory_diff` "what changed" surface
- `brain-write` — recording, linking, and retracting (with `detect_contradiction` preflight)
- `brain-conflict` — adjudicating COMPETING facts and 3+ multi-way disagreements

These describe how to actually *use* the 21 tools brain exposes, not just how to wire them in.
