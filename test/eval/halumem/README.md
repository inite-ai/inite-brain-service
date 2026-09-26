# HaluMem harness

[HaluMem](https://arxiv.org/abs/2511.03506) evaluates hallucination in an agent
memory **per operation**, not only end to end:

- **extraction**: what the memory wrote from a session, against the session's
  gold memory points. It is scored on four numbers: recall (integrity),
  precision (accuracy), F1, and whether *interference* points (things the user
  said that must not become memory) were kept out;
- **update**: when a gold point updates an earlier one, whether a search for it
  returns the new value (Correct) or keeps the old one (Omission), or returns
  something the dialogue never said (Hallucination);
- **QA**: 3.5k questions of six types: Basic Fact Recall, Multi-hop, Dynamic
  Update, Memory Conflict, Generalization, and Memory Boundary (the answer is
  "not provided", so abstention is correct).

Each metric points at a different part of brain: the extractor and the grounding
gate for extraction, the conflict resolver and supersession for update, and
retrieval and synthesis for QA.

## Licence: nothing of HaluMem is committed here

The dataset and the toolkit are **CC BY-NC-ND 4.0**. The runner reads both at run
time from copies the operator supplies:

```bash
git clone https://github.com/MemTensor/HaluMem /path/to/HaluMem           # judge + answer prompts
curl -L -o HaluMem-Medium.jsonl \
  https://huggingface.co/datasets/IAAR-Shanghai/HaluMem/resolve/main/HaluMem-Medium.jsonl
```

The prompts are taken verbatim from `eval/eval_tools.py` (the four judges) and
`eval/prompts.py` (`PROMPT_MEMZERO`, the answer prompt). If a constant is renamed,
the run fails instead of judging with nothing.

## What runs

The runner measures brain against brain, `main` vs a branch on the same slice. The
paper's own setup (a `gpt-4o` judge, a Mem0-style answerer) is not reproduced.

| Step | Here |
|---|---|
| add | each session is one chat document (`POST /v1/ingest/document`, the user's own `userId`) |
| extracted memories | what the document committed, rendered `Entity — predicate: object` |
| update probe | `POST /v1/search` for the new point, `limit: 10`, rendered `YYYY-MM-DD: Entity — predicate: object` |
| QA | brain's own answer (`POST /v1/synthesize`, strict guardrails); an abstention is answered as "I don't know", which is what Memory Boundary questions reward |
| judge | HaluMem's four judge prompts, verbatim, on `gpt-6-luna` (`HALUMEM_JUDGE_MODEL`) |

The judge only has to be the same on both arms of an A/B, so it runs on the cheap
model brain itself runs on. The judges are lenient LLM judges (0/1/2 scores,
three- or four-way verdicts). Read a HaluMem number only against another HaluMem
number from this harness.

**The stand has to run the production flags**, not the defaults. On defaults,
extraction F1 read 59.7%; on production flags it read 86.3%. Source the
`enablement.env` heredoc from `.github/workflows/deploy-brain.yml`, and add
`EMBEDDER_PROVIDER=bge-m3`.

## Running

```bash
BRAIN_BASE_URL=http://localhost:3000 BRAIN_API_KEY=brain_… BRAIN_COMPANY_ID=<fresh tenant> \
HALUMEM_DATA=/path/HaluMem-Medium.jsonl HALUMEM_REPO=/path/HaluMem \
OPENAI_API_KEY=sk-… \
HALUMEM_USERS=2 HALUMEM_SESSIONS=10 \
pnpm eval:halumem
```

| Env | Default | |
|---|---|---|
| `HALUMEM_USERS` / `HALUMEM_SESSIONS` | 2 / 10 | the slice: the first N users, and the first M sessions of each, in order (0 = all) |
| `HALUMEM_CONCURRENCY` | 2 | users in parallel (sessions of one user always run in order) |
| `HALUMEM_JUDGE_CONCURRENCY` | 8 | judge calls in parallel |
| `HALUMEM_JUDGE_MODEL` | `gpt-6-luna` | |
| `HALUMEM_OPENAI_BASE_URL` | | an OpenAI-compatible endpoint for the judge |
| `HALUMEM_RUN_ID` | generated | a re-run with the same id resumes; finished users are skipped |
| `HALUMEM_SYSTEM_FILE` | | judge an existing `halumem-system-*.jsonl` again, with no stand |
| `HALUMEM_REPORT_DIR` | `var/halumem` | |

Scale: HaluMem-Medium has 20 users, 1,387 sessions, 60k turns, 15k memory points
and 3.5k questions. The whole set means about 40k judge calls, so start from a
slice. One session writes in about 25–35 s on a local stand. A 20-session slice
means about 1.5–2k judge calls, and the accuracy judge reads the whole session
each time. Count the cost before a run.

## Output

- `halumem-system-<run>.jsonl`: what the system did, one line per user, in the
  toolkit's shape (extracted memories, update probes, answers). A judge-only
  re-run reads it.
- `halumem-<run>.json`: every metric `evaluation.py` computes, plus QA by
  question type.
