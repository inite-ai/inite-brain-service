# LoCoMo benchmark

Brain runs against [LoCoMo](https://github.com/snap-research/locomo)
through its production ingest + retrieval surface — no harness-only
adapters. Each conversation is ingested via `POST /v1/ingest/mention`
(the NLU extractor turns each turn into facts the same way it would
for real traffic); QA is answered through `POST /v1/search/multi-hop`
with synthesize layered on top. The "MCP + Anthropic" agent variant
runs the same workload through a Claude agent with brain MCP bound —
that's the apples-to-apples comparison vs Mem0 / Zep / MemGPT.

## Methodology

| Stage | What it does | Brain surface |
|---|---|---|
| Ingest | One turn → one mention. Speaker timestamp threaded through as `validFrom`. NLU extractor in brain pulls entities + facts. | `POST /v1/ingest/mention` |
| Retrieval | Planner-LLM decomposes the question; chained search anchored to the running entity set; synthesize produces the final grounded answer. | `POST /v1/search/multi-hop` + `POST /v1/synthesize` |
| Scoring | Token F1 (SQuAD convention), ROUGE-L (LCS-based), BLEU-1 with brevity penalty, exact match, plus a refusal-aware adversarial score for category 5. | Pure functions in `test/eval/locomo/metrics.ts` |

Categories follow the paper:

| # | Name | What it tests |
|---|---|---|
| 1 | Single-hop | Answer is in one turn — basic recall. |
| 2 | Multi-hop | Requires joining evidence across turns / sessions. |
| 3 | Temporal | Requires reasoning about WHEN something happened. Brain's `asOf` and bitemporal cutoff carry their weight here. |
| 4 | Open-domain | Requires commonsense beyond the conversation. |
| 5 | Adversarial | Gold answer is a refusal. Confabulating a specific answer scores 0; refusing scores 1. |

## Procurement

The dataset is CC-BY-4.0 but not vendored in this repo. Download from
upstream:

```bash
# Option A — clone the dataset repo
git clone https://github.com/snap-research/locomo.git /tmp/locomo
ls /tmp/locomo/data/

# Option B — direct download (newer bundled form, when published)
curl -L https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json \
  -o /tmp/locomo10.json
```

The runner accepts either the bundled `{ samples: [...] }` shape or a
bare top-level array — the loader auto-detects.

## Running

Bring brain up locally with at least these scopes on the API key:

```
brain:read  brain:write  brain:read_pii  brain:admin
```

A fresh dev SurrealDB works fine — the runner picks
`co_locomo_<sampleId>` per sample so existing tenants stay
untouched.

Smoke run on one conversation (~$5–10):

```bash
OPENAI_API_KEY=sk-... \
  tsx scripts/run-locomo.ts \
    --dataset /tmp/locomo10.json \
    --brain-url http://localhost:3000 \
    --api-key local-dev-key \
    --samples 1 \
    --out var/locomo-smoke.json
```

Full run (~$80 on gpt-4o-mini, ~2–4h wall clock):

```bash
OPENAI_API_KEY=sk-... \
  tsx scripts/run-locomo.ts \
    --dataset /tmp/locomo10.json \
    --brain-url http://localhost:3000 \
    --api-key local-dev-key \
    --out var/locomo-full.json
```

After ingest, the same report can be regenerated against the populated
brain without re-paying for extraction:

```bash
tsx scripts/run-locomo.ts \
  --dataset /tmp/locomo10.json \
  --brain-url http://localhost:3000 \
  --api-key local-dev-key \
  --skip-ingest \
  --out var/locomo-qa-only.json
```

## Two QA agent profiles

The runner exposes both natural paths brain ships:

| Agent | Where it lives | Numbers report |
|---|---|---|
| `HttpAgent` | `test/eval/locomo/http-agent.ts` | Lower bound — direct `/search/multi-hop` + `/synthesize`, no agent CoT. Deterministic; what CI uses. |
| `ClaudeMcpAgent` | not yet shipped — natural fit for the next phase | Apples-to-apples vs Mem0 / Zep / MemGPT, whose papers all use a Claude / GPT agent through their API. |

Both consume the same QaAgent interface so the metric pipeline is
identical — only the answer-generation strategy varies.

### MCP surface (used by the agent variant)

The MCP server exposes the full read-side stack agents need for
LoCoMo-shape work:

- `search_knowledge` — one-shot hybrid retrieval (vector + BM25 +
  listwise rerank)
- `search_multi_hop` — planner-LLM chained search; same planner the
  HttpAgent path uses, so agent-natural numbers exercise the same
  retrieval logic
- `synthesize` — corrective-RAG with claim-level verifier; strict /
  lenient / off guardrails
- `get_entity_profile` / `get_entity_timeline` /
  `find_related_entities` — graph drill-downs the planner doesn't
  substitute for

Write tools (`record_fact`, `retract_fact`, `link_entities`,
`forget_entity`) sit behind their own scopes and aren't exercised by
LoCoMo — LoCoMo is a read benchmark.

**No `ingest_mention` MCP tool** — ingest stays HTTP-only. This is
intentional: in production, ingestion runs from the event bus, not
from an agent. The Claude-MCP agent path only answers questions, so
the asymmetry doesn't hurt the bench.

## Why this is fair

LoCoMo evaluates memory systems as agents see them. We don't pre-
extract facts from LoCoMo transcripts using harness-only logic and
seed them straight into brain — we hand each turn to brain's
production NLU extractor through the public `/v1/ingest/mention`
endpoint. Whatever facts get pulled out are exactly what brain would
have stored for that same conversation arriving live from a vertical.

That's also why the smoke fixture matters less than for unit tests:
LoCoMo questions probe brain's whole pipeline (extractor, indexer,
retriever, planner, synthesizer) — the only meaningful smoke is one
real conversation through the full extractor, not a synthetic one.

## What goes in the report

The runner emits a single JSON report:

```json
{
  "generatedAt": "2026-06-22T22:00:00.000Z",
  "totalQuestions": 1540,
  "overall": {
    "n": 1540,
    "f1": 0.0,
    "rougeL": 0.0,
    "bleu1": 0.0,
    "exactMatch": 0.0,
    "adversarial": 0.0
  },
  "perCategory": [
    { "category": 1, "n": 480, "f1": 0.0, "rougeL": 0.0, "bleu1": 0.0, "exactMatch": 0.0, "adversarial": 0.0 },
    ...
  ],
  "perSample": [
    { "sampleId": "conv-1", "n": 154, "f1": 0.0 },
    ...
  ],
  "scores": [
    { "sampleId": "conv-1", "category": 1, "question": "...", "gold": "...", "prediction": "...", "f1": ..., "rougeL": ..., "bleu1": ..., "exactMatch": ..., "adversarial": ... },
    ...
  ]
}
```

`scores[]` is the full per-question rollup — keep it to drill into
exactly which question the regression hit. Aggregates above are
derived from it.

## Agents

Two QA agents ship in `test/eval/locomo/`:

- **HttpAgent** (default, `--agent http`) — drives brain through the
  v1 HTTP surface (`/v1/search/multi-hop` + `/v1/synthesize`). One
  shot per question, no agent-level chain-of-thought. Deterministic,
  no Anthropic key, comparable run-to-run. This is the LOWER BOUND
  on what brain can do — what the retrieval stack itself produces
  without an agent on top.

- **ClaudeMcpAgent** (`--agent claude-mcp`) — Claude calls brain
  through the MCP transport with tool-use loops (default max 6
  turns). Apples-to-apples with the agent-level numbers Mem0 / Zep /
  MemGPT publish. Needs `ANTHROPIC_API_KEY` env + `--company-id <id>`
  to build the MCP URL. Cost: ~$30 of Claude on top of the ~$80 of
  brain-side OpenAI for the full 10-sample run.

Run with claude-mcp:

```bash
OPENAI_API_KEY=… ANTHROPIC_API_KEY=… BRAIN_API_KEY=brain_… \
  tsx scripts/run-locomo.ts \
    --dataset /tmp/locomo10.json \
    --agent claude-mcp \
    --company-id co_locomo \
    --out var/locomo-claude-mcp.json
```

The agent spawns one MCP transport for the lifetime of the run; the
runner closes it at the end. Claude sees the full read-baseline tool
surface (15 tools at brain:read; 20 with brain:write); pick a
read-only key for the QA leg if you want to be sure no fact write
leaks back into the graph mid-run.

## What's deferred

- **BERTScore** — paper mentions it as a supplementary metric. Adds a
  400MB BERT-base download + ~30 min CI to the pipeline for a number
  that doesn't change rankings vs F1. Easy to bolt on later via a
  downstream consumer that reads `scores[].prediction` + `scores[].gold`.
- **CI gating** — once a baseline is established, the LoCoMo report
  joins the existing eval baseline diff in CI (`scripts/eval-baseline-diff.ts`).
