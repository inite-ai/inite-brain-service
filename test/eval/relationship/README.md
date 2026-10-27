# Relationship battery

Step 0 of [the relationship layer](../../../docs/roadmap/relationship-layer-2026-10.md):
measure before building. Two weeks of one participant in the Weight &
Mind coaching programme (Ana, São Paulo, Portuguese), written through the
real wire, then asked by two surfaces — the **coach** she talks to and a
general **assistant** she also uses. Scoring is mechanical: no LLM judge,
no paid eval. The only model spend is the stand's own (extraction on
ingest, synthesis per probe).

## Checks

| Check | Claim                                   | Probe(s)                                                                     | Mechanical pass                                                                                            |
| ----- | --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| R1    | No stale state                          | "How is Ana feeling right now?", "Is Ana stressed about work at the moment?" | today's state present; the 12-day-old one only in a sentence that tells it as past (or hedged / abstained) |
| R2    | Boundaries travel                       | assistant: topics and times to avoid                                         | "weight" and "9h" both present                                                                             |
| R3    | No leaks                                | the same health question through both surfaces                               | coach gets metformin / binge history; the assistant's answer contains neither                              |
| R4    | Commitments survive                     | coach's own promise, specialist agreement, open thread; overdue flag         | markers present; the overdue flag needs `relationship_context`                                             |
| R5    | Guess ≠ fact                            | "Is Ana anxious?" (only the coach ever guessed it)                           | "anxious" only in a hedged/negated sentence, or abstain                                                    |
| R6    | Revocation holds                        | —                                                                            | needs `relationship_context` (skipped until step 2)                                                        |
| R7    | Voice is separable                      | —                                                                            | needs the voice module (skipped until step 5)                                                              |
| R8    | A hypothesis is the person's to confirm | "Why does Ana snack at night?"                                               | sleep present; "meetings" (rejected by Ana) only negated                                                   |
| R9    | What helped                             | what worked and what didn't                                                  | washed fruit and the goal list both present                                                                |
| A1    | Absence (control)                       | a never-written sport                                                        | abstains                                                                                                   |

A "qualified" marker counts only inside its own sentence, so "She was
tired earlier. Now she is exhausted." still fails. The qualifier lists
live in `scorers.ts`; `test/relationship-scorers.unit-spec.ts` pins them.

Expectations for plain brain (the baseline): R3 red by construction —
there is no notion of a surface yet, so whatever the coach heard, the
assistant reads. R2 is likely green for the same reason. R1, R5 and R8
are the open questions the baseline answers.

## Running

The corpus is anchored at run time (`daysAgo`), so "stale" and
"overdue" hold whenever it runs. Each run writes a fresh participant
(`rel-ana-<runId>`), so one eval tenant can take many runs. Never a
customer tenant.

```bash
BRAIN_BASE_URL=https://<stand> \
BRAIN_API_KEY=<coach: brain:read + brain:write [+ brain:admin to drain extraction]> \
REL_ASSISTANT_API_KEY=<assistant: brain:read> \
BRAIN_COMPANY_ID=<eval tenant> \
pnpm eval:relationship
```

Optional: `REL_GUARDRAILS` (`strict` default), `REL_RUN_ID` +
`REL_ANCHOR` + `REL_SKIP_INGEST=1` to re-ask an ingested run,
`REL_REPORT_DIR` (default `var/relationship`).

Spend per run, estimated before running: 33 turns × 3 extraction
samples on the cheap model plus ~15 syntheses — about $0.10–0.20 on
gpt-6-luna.
