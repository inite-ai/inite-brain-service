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

## Protocol

These are the toolkit's own adapter choices, kept so the numbers compare:

| Step | Toolkit (Mem0 adapter) | Here |
|---|---|---|
| add | the whole session in one `add` | the session as one chat document (`POST /v1/ingest/document`, the user's own `userId`) |
| extracted memories | what `add` returned | what the document committed, rendered `Entity — predicate: object` |
| update probe | top-10 search for the new point | `POST /v1/search`, `limit: 10`, rendered `YYYY-MM-DD: Entity — predicate: object` |
| QA context | top-20 search, `TEMPLATE_MEM0` | top-20 search (`HALUMEM_TOP_K`), the same template |
| QA answer | `PROMPT_MEMZERO` → `gpt-4o`, temperature 0 | `PROMPT_MEMZERO` → `gpt-6-luna` by default (`HALUMEM_ANSWER_MODEL`) |
| judge | `gpt-4o`, temperature 0 | `gpt-6-luna` by default (`HALUMEM_JUDGE_MODEL`) |

**Models.** The paper judges and answers with `gpt-4o`. Here both default to `gpt-6-luna`, the model the rest of brain runs on, which is 20–25× cheaper. An A/B (main vs branch) only needs the same judge on both arms, not the paper's judge. Set both to `gpt-4o` for a one-off run that should sit next to the paper's table.

QA runs a second arm, **synthesize**: brain's own answer from `POST /v1/synthesize`.
Strict guardrails apply, and an abstention is answered as "I don't know."
Memory Boundary questions reward exactly that. The `protocol` arm is the one to
compare with published numbers; `synthesize` is what a client of brain gets.

The judges are LLM judges with 0/1/2 scores and three- or four-way verdicts.
That is lenient compared with the strict binary judge of
[docs/eval-protocol.md](../../../docs/eval-protocol.md). Quote HaluMem numbers
as HaluMem numbers, next to the paper's own table and not next to ours.

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
| `HALUMEM_ARMS` | `protocol,synthesize` | QA arms |
| `HALUMEM_TOP_K` | 20 | QA search depth |
| `HALUMEM_CONCURRENCY` | 2 | users in parallel (sessions of one user always run in order) |
| `HALUMEM_JUDGE_CONCURRENCY` | 8 | judge calls in parallel |
| `HALUMEM_JUDGE_MODEL` / `HALUMEM_ANSWER_MODEL` | `gpt-6-luna` | `gpt-4o` reproduces the paper's setup, at 20–25× the price |
| `HALUMEM_OPENAI_BASE_URL` | | an OpenAI-compatible endpoint for both |
| `HALUMEM_RUN_ID` | generated | a re-run with the same id resumes; finished users are skipped |
| `HALUMEM_SYSTEM_FILE` | | judge an existing `halumem-system-*.jsonl` again, with no stand |
| `HALUMEM_REPORT_DIR` | `var/halumem` | |

Scale: HaluMem-Medium has 20 users, 1,387 sessions, 60k turns, 15k memory points
and 3.5k questions. The whole set means about 40k judge calls, so start from a
slice. One session writes in about 25–35 s on a local stand. A 20-session slice
means about 1.5–2k judge calls, and the accuracy judge reads the whole session
each time. On `gpt-4o` that burned the day's credits in three runs.

## Output

- `halumem-system-<run>.jsonl`: what the system did, one line per user, in the
  toolkit's shape (extracted memories, update probes, answers). A judge-only
  re-run reads it.
- `halumem-<run>.json`: every metric `evaluation.py` computes, plus QA by
  question type.
