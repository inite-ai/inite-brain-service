# INITE Brain TypeScript SDK Quickstart

A runnable, self-contained example demonstrating how to use the [`@inite/brain`](../../clients/brain-sdk) TypeScript SDK with a local or hosted INITE Brain service.

This example walks through the core agent memory loop:

1. **`remember()`**: Ingest natural language sentences about a person, extracting entities and bitemporal facts.
2. **`recall()`**: Run hybrid retrieval (vector + BM25) to retrieve relevant entities and structured facts.
3. **`answer()`**: Synthesize a direct answer with citations based on stored memories.
4. **`timeline()`**: Inspect the bitemporal transaction-time event history of an entity.

---

## Prerequisites

- Node.js 18+
- A running INITE Brain instance (local or hosted at `https://brain.inite.ai`)
- An API key (`brain_...`) with permissions to ingest and query

To run Brain locally, follow the root [README § Run locally](../../README.md#run-locally):

```bash
docker compose up -d surrealdb
pnpm start:dev
```

---

## Environment Variables

| Variable        | Required | Default                 | Description                                  |
| --------------- | -------- | ----------------------- | -------------------------------------------- |
| `BRAIN_KEY`     | **Yes**  | _None_                  | Your API key / Bearer token for Brain        |
| `BRAIN_URL`     | No       | `http://localhost:3000` | Base URL of the Brain service                |
| `BRAIN_USER_ID` | No       | `quickstart-demo-user`  | Tenant-scoped user ID for read/write fencing |

> **Important:** Always supply the same `userId` for writes and reads. In Brain, memories written under a `userId` are fenced to that user and will be invisible to queries without that user scope.

---

## Setup and Running

The SDK is published as [`@inite/brain`](https://www.npmjs.com/package/@inite/brain); this example depends on the in-repo package (`clients/brain-sdk`) so it always runs against the SDK of the same commit.

### 1. Build the Brain SDK

From the repository root:

```bash
npm --prefix clients/brain-sdk install
npm --prefix clients/brain-sdk run build
```

### 2. Install and run the quickstart

```bash
cd examples/sdk-quickstart
npm install
BRAIN_KEY=your_api_key npm start
```

Or connect to a custom Brain instance:

```bash
BRAIN_KEY=your_api_key BRAIN_URL=http://localhost:3000 BRAIN_USER_ID=my-user npm start
```

---

## Sample Output

A real run against `https://brain.inite.ai` (ids are your tenant's own; long JSON trimmed). The write returns at receipt with `pending: true` — extraction runs in the background, so the script asks again until the memory has it (36 s here):

```text
🧠 INITE Brain TypeScript SDK Quickstart

--- Step 1: Remember ---
Input text:
"Maria Vance moved to Berlin in June 2026. She works as a distributed systems architect and prefers morning syncs."

Remember result: {
  "skipped": false,
  "pending": true,
  "extractedEntityIds": [],
  "extractedFactIds": [],
  "episodeId": "episode:5gtjc91icwq2mvn7tr44"
}

Waiting for background extraction (up to 3 minutes)...

--- Step 2: Recall ---
Recall query: "Where does Maria Vance live and what does she do?"

Found 1 recall hit(s):
- Entity: Maria Vance (ID: knowledge_entity:8nt58l3yvy4cuva60gqq, Type: staff, Score: 0.180)
    • moved_to → Berlin (confidence: 1)
    • works_as → distributed systems architect (confidence: 1)
    • prefers_morning_syncs → morning syncs (confidence: 1)

--- Step 3: Answer with Citations ---
Question: "Where does Maria Vance live and what does she do?"

Answer:
Maria Vance moved to Berlin [knowledge_edge:aadi61f4aadwpsudvi4l] and works as a distributed systems architect [knowledge_fact:1b9un1hf9kkisleb3vnu].

Citations (2): [
  {
    "factId": "knowledge_edge:aadi61f4aadwpsudvi4l",
    "entityId": "knowledge_entity:8nt58l3yvy4cuva60gqq",
    "canonicalName": "Maria Vance",
    "predicate": "moved_to",
    "object": "Berlin"
  },
  {
    "factId": "knowledge_fact:1b9un1hf9kkisleb3vnu",
    "entityId": "knowledge_entity:8nt58l3yvy4cuva60gqq",
    "canonicalName": "Maria Vance",
    "predicate": "works_as",
    "object": "distributed systems architect",
    "validFrom": "2026-10-27T17:42:11.656Z"
  }
]

--- Step 4: Timeline ---
Fetching timeline for entity: knowledge_entity:8nt58l3yvy4cuva60gqq

Timeline events (3): [
  {
    "type": "fact.recorded",
    "at": "2026-10-27T17:42:43.921Z",
    "validFrom": "2026-06-01T00:00:00.000Z",
    "factId": "knowledge_fact:g92k5eyurzfnnzjfkp5g",
    "predicate": "moved_to",
    "object": "Berlin",
    "source": { "documentId": "source_document:z6ix40mlegwh3s787j74", "episodeIds": ["episode:5gtjc91icwq2mvn7tr44"], … },
    "confidence": 1
  },
  …
]

✅ Quickstart completed successfully.
```

A citation's `factId` can be a fact (`knowledge_fact:…`) or a graph relation (`knowledge_edge:…`); both are resolvable with `get_fact_provenance`.
