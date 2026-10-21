# INITE Brain TypeScript SDK Quickstart

A runnable, self-contained example demonstrating how to use the [`@inite/brain`](../../clients/brain-sdk) TypeScript SDK with a local or hosted INITE Brain service.

This example walks through the core agent memory loop:
1. **`remember()`**: Ingest natural language sentences about a person, extracting entities and bitemporal facts.
2. **`recall()`**: Run hybrid retrieval (vector + BM25) to retrieve relevant entities and structured facts.
3. **`answer()`**: Synthesize a direct answer with citations based on stored memories.
4. **`timeline()`**: Inspect the bitemporal transaction-time event history of an entity.

---

## Prerequisites

- Node.js 18+ (tested with Node 20 / 22 / 24)
- A running INITE Brain instance (local or hosted at `https://brain.inite.ai`)
- An API key (`brain_...`) with permissions to ingest and query

To run Brain locally, follow the root [README § Run locally](../../README.md#run-locally):
```bash
docker compose up -d surrealdb
pnpm start:dev
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRAIN_KEY` | **Yes** | _None_ | Your API key / Bearer token for Brain |
| `BRAIN_URL` | No | `http://localhost:3000` | Base URL of the Brain service |
| `BRAIN_USER_ID` | No | `quickstart-demo-user` | Tenant-scoped user ID for read/write fencing |

> **Important:** Always supply the same `userId` for writes and reads. In Brain, memories written under a `userId` are fenced to that user and will be invisible to queries without that user scope.

---

## Setup and Running

Because the SDK is under active development in this repository and not yet published to npm, this example depends on the local SDK package (`clients/brain-sdk`).

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

```text
🧠 INITE Brain TypeScript SDK Quickstart
Connecting to: http://localhost:3000
User scope: quickstart-demo-user

--- Step 1: Remember ---
Input text:
"Maria Vance moved to Berlin in June 2026. She works as a distributed systems architect and prefers morning syncs."

Remember result: {
  "skipped": false,
  "extractedEntityIds": [
    "entity_maria_vance"
  ],
  "extractedFactIds": [
    "fact_berlin_residence",
    "fact_role_architect",
    "fact_pref_syncs"
  ]
}

Waiting for background extraction to settle...

--- Step 2: Recall ---
Recall query: "Where does Maria Vance live and what does she do?"

Found 1 recall hit(s):
- Entity: Maria Vance (ID: entity_maria_vance, Type: person, Score: 0.942)
    • lives_in → Berlin (confidence: 0.98)
    • role → distributed systems architect (confidence: 0.95)
    • preference → morning syncs (confidence: 0.92)

--- Step 3: Answer with Citations ---
Question: "Where does Maria Vance live and what does she do?"

Answer:
Maria Vance lives in Berlin (having moved there in June 2026) and works as a distributed systems architect.

Citations (2): [
  {
    "factId": "fact_berlin_residence",
    "predicate": "lives_in",
    "object": "Berlin"
  },
  {
    "factId": "fact_role_architect",
    "predicate": "role",
    "object": "distributed systems architect"
  }
]

--- Step 4: Timeline ---
Fetching timeline for entity: entity_maria_vance

Timeline events (3): [
  {
    "type": "fact_recorded",
    "predicate": "lives_in",
    "object": "Berlin",
    "validFrom": "2026-06-01T00:00:00.000Z",
    "recordedAt": "2026-10-16T21:00:00.000Z"
  },
  {
    "type": "fact_recorded",
    "predicate": "role",
    "object": "distributed systems architect",
    "validFrom": "2026-06-01T00:00:00.000Z",
    "recordedAt": "2026-10-16T21:00:00.000Z"
  },
  {
    "type": "fact_recorded",
    "predicate": "preference",
    "object": "morning syncs",
    "validFrom": "2026-10-16T21:00:00.000Z",
    "recordedAt": "2026-10-16T21:00:00.000Z"
  }
]

✅ Quickstart completed successfully.
```
