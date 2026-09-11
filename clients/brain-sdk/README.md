# @inite/brain

TypeScript SDK for [INITE Brain](https://brain.inite.ai) — long-term
memory for agents: bitemporal facts, hybrid retrieval, answers with
citations.

```bash
npm install @inite/brain
```

Three layers, each usable without the others.

## 1. The client

```ts
import { createBrain } from '@inite/brain'

const brain = createBrain({
  apiKey: process.env.BRAIN_KEY!,
  userId: 'user_42', // threaded onto every call
})

await brain.remember('Maria moved to Berlin in June and prefers morning appointments.')

const hits = await brain.recall('where does Maria live')
const { answer, citations } = await brain.answer('where does Maria live')
const history = await brain.timeline(hits[0].entityId)
```

`userId` is threaded onto **every** call, including the query string on
GETs. Writing with a user scope and reading without one returns nothing,
and nothing about that failure looks like a bug — so it is not something
you get to forget per call.

The client is deliberately small: `remember`, `recordFact`, `recall`,
`answer`, `entity`, `timeline`. Brain's REST surface has sixty-odd paths
and the [OpenAPI document](https://brain.inite.ai/openapi.json) generates
whatever you need for the long tail. What belongs in a hand-written
client is the handful of calls an agent makes in a loop.

## 2. Tools, for any framework

```ts
import { generateText } from 'ai'
import { createBrain, brainTools } from '@inite/brain'

await generateText({
  model,
  tools: brainTools(brain),
  prompt: 'What do we know about Maria?',
})
```

`brainTools()` returns `{ description, inputSchema, execute }` objects —
what the Vercel AI SDK's `tools:` map takes directly, and what the OpenAI
Agents SDK and Mastra accept with a one-line wrap.

Four tools, not fourteen: `recall_memory`, `answer_from_memory`,
`remember`, `memory_history`. Every tool costs context on every turn
whether or not it is called, and an agent that can search, answer, write
and read history can do the work. The rest of brain's surface is one
[MCP connection](https://brain.inite.ai/en/docs/mcp/setup) away when it
is actually needed.

## 3. A LangGraph-shaped store

```ts
import { createBrain, createBrainStore } from '@inite/brain'

const store = createBrainStore(brain)
await store.put(['users', userId, 'prefs'], 'editor', { tabs: true })
const item = await store.get(['users', userId, 'prefs'], 'editor')
```

`get` / `put` / `delete` / `search` / `listNamespaces` over hierarchical
namespaces, backed by brain's memory files. Pass it where LangGraph wants
a store.

It is a **structural** implementation, not a subclass: a
`@langchain/langgraph` dependency here would be a dependency for everyone
installing this package, including people using it with the AI SDK or
with nothing at all.

A miss answers `null` rather than throwing, because every other store
does and a graph node written against one of them will not be wrapping
it in a try/catch. `search` filters on exact field matches and does not
pretend to do vector ranking over a directory of JSON blobs — the same
key searches the actual knowledge graph with `brain.recall()`.

## Why one dependency

`zod`, and nothing else. A zod schema plus an async function is the
common denominator of every JS agent framework worth adapting to, so one
object serves all of them and none of them has to be installed.

---

Source: [`clients/brain-sdk`](https://github.com/inite-ai/inite-brain-service/tree/main/clients/brain-sdk)
· [docs](https://brain.inite.ai/en/docs)
· AGPL-3.0-or-later
