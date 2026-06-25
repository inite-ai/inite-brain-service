# @inite/brain-mcp

First-party **stdio MCP connector** for the [INITE Brain](https://brain.inite.ai).

Brain speaks MCP over **Streamable HTTP** with a Bearer API key
(`POST /mcp/:companyId`). Harnesses that natively support remote MCP
(Claude Desktop, Cursor, Goose v2) connect directly by URL — see the
`brain-mcp-setup` skill. But many harnesses only know how to **spawn a
stdio MCP server** as a subprocess and have no way to attach an
`Authorization` header (openclaw, the planned hermes, Goose 1.x, …).

This binary bridges the gap. The harness spawns it over stdio; it
transparently proxies every tool the API key is scoped for to the remote
brain:

```
harness ──stdio──▶ brain-mcp ──HTTP + Bearer──▶ https://brain.inite.ai/mcp/<companyId>
```

It is a **transparent passthrough** — it does not rename or curate tools.
`tools/list` and `tools/call` are forwarded verbatim, so the harness sees
exactly the surface the key unlocks (read → 15 tools, +write → 20, +admin → 21).

## Configuration

All config is via environment variables (harnesses pass these as `env`):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BRAIN_API_KEY` | yes | — | `brain_…` key from https://brain.inite.ai/admin/keys |
| `BRAIN_COMPANY_ID` | yes\* | — | your companyId (same page); \*not needed if `BRAIN_MCP_URL` is set |
| `BRAIN_BASE_URL` | no | `https://brain.inite.ai` | for self-hosted brain |
| `BRAIN_MCP_URL` | no | — | full endpoint override; wins over BASE_URL + COMPANY_ID |

## Wiring it into a harness

### openclaw (and any stdio-only harness)

In the harness MCP config (`mcp.servers`):

```json
{
  "mcp": {
    "servers": {
      "brain": {
        "command": "npx",
        "args": ["-y", "@inite/brain-mcp"],
        "env": {
          "BRAIN_API_KEY": "brain_xxxxxxxx",
          "BRAIN_COMPANY_ID": "your-company-id"
        }
      }
    }
  }
}
```

That's it — all brain tools (`search_knowledge`, `record_fact`,
`memory_diff`, `detect_contradiction`, …) appear to the agent automatically.

### hermes / a custom agent (raw `@modelcontextprotocol/sdk`)

Spawn it with `StdioClientTransport`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@inite/brain-mcp'],
  env: { BRAIN_API_KEY: process.env.BRAIN_API_KEY!, BRAIN_COMPANY_ID: 'your-company-id' },
});
const client = new Client({ name: 'hermes', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();
```

### Self-hosted brain

Add `BRAIN_BASE_URL` (e.g. `http://localhost:3000`) to the `env`, or set
`BRAIN_MCP_URL` to the full `…/mcp/<companyId>` endpoint.

## Notes

- **stdout is the MCP wire** — all diagnostics go to stderr.
- The bridge holds one upstream connection per spawned process. Brain is
  stateless, so each tool call is an independent HTTP round-trip; if the
  upstream connection drops the bridge exits non-zero so the harness notices.
- Auth, tenancy isolation, scopes and PII fencing are enforced **server-side**
  by brain from the key — the bridge only carries the Bearer token.

## Build from source

```bash
npm install
npm run build   # → dist/index.js
```

Licensed AGPL-3.0-or-later.
