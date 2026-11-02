# Claim-check battery (#877)

Every cited sentence of an answer is put to the local NLI model
(mDeBERTa-xnli, the one Brain already loads) against the facts it cites
(`src/synthesize/claim-check.ts`). No paid model call.

```bash
pnpm eval:claim-check                       # rule: nli
pnpm eval:claim-check -- --rule=nli+numbers # rule: nli + the #851 number-clash check
```

**Rules, fixed before measuring.** `nli` removes a sentence iff the label is
`contradiction`; `nli+numbers` also removes one whose numbers clash with the
cited facts (`valueCheck` → `reject`, the deterministic check #851 applies to
extracted values). `neutral` always keeps: paraphrase and inference read as
neutral.

**Data.** 30 answers, 36 sentences (34 cited) in EN/RU/PT, gold per sentence:
supported / neutral / contradicted / uncited. Categories: paraphrase, number,
date, negation, entity, inference, mixed, crosslingual (facts in English,
answer in Russian or Portuguese).

## Measured (2026-11-02, local ONNX, loaded machine)

| rule          | contradicted caught | precision | false removals |
| ------------- | ------------------- | --------- | -------------- |
| `nli`         | 58.8% (10/17)       | 100%      | 0% (0/17)      |
| `nli+numbers` | **70.6%** (12/17)   | **100%**  | **0%** (0/17)  |

- Caught by both: every negation (4/4) and every cross-lingual contradiction (2/2).
- NLI reads a swapped number, date or entity as `neutral`; the number check
  catches the numbers (3/3). Still missed: dates in words ("in April",
  "segunda-feira"), a swapped entity ("Amsterdam" for "Frankfurt"), a number
  in words ("três"), and one technical contradiction.
- 561 ms per pair on this machine (load average ~360); a real answer cites a
  few facts, so a cap on pairs per answer keeps the cost bounded.

**Recommendation.** Ship `nli+numbers` as specified in #877: it never removed
a supported sentence here and catches 7 in 10 contradictions; the LLM
verifier stays in front of it where one runs. Not shipped by this battery —
wiring it into synthesis is the product step the spec asks approval for.
