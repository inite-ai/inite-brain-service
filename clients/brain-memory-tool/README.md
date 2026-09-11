# @inite/brain-memory-tool

Anthropic's memory tool (`memory_20250818`), backed by INITE Brain
instead of a directory on one machine.

The memory tool hands a model a filesystem it owns — `view`, `create`,
`str_replace`, `insert`, `delete`, `rename` under `/memories` — and
leaves the storage to you. Every reference implementation writes to local
disk, which forgets on redeploy, is invisible to every other surface, and
belongs to whichever container happened to handle the request.

This package is the same command surface over a tenant-fenced memory
service. **Your agent loop does not change.**

```bash
npm install @inite/brain-memory-tool
```

```ts
import Anthropic from '@anthropic-ai/sdk'
import { createBrainMemory, MEMORY_TOOL_DEFINITION } from '@inite/brain-memory-tool'

const memory = createBrainMemory({ apiKey: process.env.BRAIN_KEY! })
const client = new Anthropic()

const response = await client.beta.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 2048,
  tools: [MEMORY_TOOL_DEFINITION],
  betas: ['context-management-2025-06-27'],
  messages,
})

// in your tool_use dispatch:
for (const block of response.content) {
  if (block.type === 'tool_use' && block.name === 'memory') {
    const result = await memory.handle(block.input as never)
    // → push a tool_result block with `result`
  }
}
```

## Options

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | Required. A `brain_…` key, or any bearer credential brain accepts. |
| `baseUrl` | `https://brain.inite.ai` | Point at a self-hosted deployment. |
| `userId` | — | Set when one workspace key serves several people: each gets their own `/memories`, fenced by brain rather than by a path convention you have to police. |
| `timeoutMs` | `15000` | Per request. |
| `fetch` | global | Injected in tests. |

## Behaviour worth knowing

**`handle()` never throws.** A thrown error inside a tool dispatch ends
the turn; a string the model can read lets it recover, which is what a
filesystem backend's `ENOENT` does too. Failures come back as
`Error: …`.

**`str_replace` refuses an ambiguous edit.** Two matches means the model
gets told to include more surrounding text, not a guess at which one it
meant. Guessing silently corrupts its own notes.

**Content is stored verbatim.** No trimming, no re-wrapping, no
normalising line endings. `str_replace` and `insert` are string
operations against exactly those bytes.

**`str_replace` and `insert` run here, not on the server.** They are
read-modify-write on exact text, and a server owning that merge policy
would be a server guessing at the model's intent. Brain stores and
returns; this package edits.

## What you get over a directory

The notes survive a redeploy, they are behind the same auth and the same
per-user fence as the rest of that workspace's memory, and they are one
API call away from the rest of the product — the same key reads the
knowledge graph, the timeline and the provenance behind any fact.

## Self-hosting

The surface is `PUT /v1/memory-files` plus four POST routes, documented in
the [OpenAPI document](https://brain.inite.ai/openapi.json) under
**Memory files**. Nothing here is hosted-only.

---

Source: [`clients/brain-memory-tool`](https://github.com/inite-ai/inite-brain-service/tree/main/clients/brain-memory-tool)
· [docs](https://brain.inite.ai/en/docs/api/memory-files)
· AGPL-3.0-or-later
