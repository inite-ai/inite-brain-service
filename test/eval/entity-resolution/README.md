# Entity-resolution battery

Measures how well the naming ladder (`EntityUpsertService.resolveOrCreateNamedEntity`:
hint → known → exact → article-variant → translit → code-alias → judge → created)
keeps one entity per real thing and two for two things. Mechanical and free: the
real ladder and the real fact write path against a real SurrealDB, no paid model.

```bash
SURREALDB_URL=ws://127.0.0.1:8000 pnpm eval:entity-resolution            # all three modes
SURREALDB_URL=… pnpm eval:entity-resolution --judge=off --json          # one mode, JSON
```

Each run uses a fresh tenant and drops it afterwards.

## Data

`dataset.json` is a labelled stream of 56 mentions in 25 gold clusters (EN, RU, PT;
people, organisations, a code module), ingested in order. Every mention carries its
gold `cluster` and a `category` saying how it relates to the earlier mentions of its
cluster; its facts are written to whatever entity it lands on, so later mentions are
judged against them.

- Deterministic variants: `exact`, `inflection` (Russian case form with the base form
  the extractor supplies), `inflection-raw` (no base form), `translit`
  (Cyrillic ↔ Latin), `diacritic`, `article` (`The Guardian`/`Guardian`,
  `o Banco Inter`/`Banco Inter`), `code-alias` (path ↔ symbol).
- Judge-only variants: `nickname` (Bob/Robert, Sasha/Alexander), `abbreviation`
  (IBM), `partial` (`Costa`, `Northwind`), `suffix` (`… GmbH`).
- Hard negatives (founding mentions of a cluster built to be confused with another):
  `same-name-different` (two John Smiths, two Maria Gonzalezes, two Elena Rossis with
  contradicting facts) and `near-name` (Petrov/Petrova siblings, Ivan Petrov/Sidorov,
  Acme Corp/Labs, Helix Studio/Pharma, Alexander/Alexandra Volkov).

## Modes

- `off` — the judge is unavailable (harness mode, or no model key): what the
  deterministic ladder settles alone.
- `oracle` — the judge answers from the gold labels, for whichever candidate the ladder
  hands it: the ceiling a perfect judge reaches. It never sees a pair the ladder did not
  surface, so this measures candidate generation.
- `deferred` — no judge at ingest (as `off`), then the nightly dedup pass
  (`DreamsDedupService`) with the gold-label judge, night after night until one links
  nothing new. That is where a keyless or harness install ends up: there the connected
  agent judges the nightly pairs and nothing at ingest. A mention whose entity the pass
  linked to another is scored on the linked identity (rung `dream`, counted as judged).

Embeddings are the e2e `StubEmbedder`, so the embedding scan finds nothing real and the
oracle ceiling is a lower bound for a bge-m3 deployment; the transliterated-key scan is
string-based and runs as in production.

## Metrics

Pairwise P/R/F1 over mention pairs; B³ P/R/F1; **auto-merge precision** (mentions a
deterministic rung attached to an existing entity that landed on their own cluster — a
false merge fuses two people's memory with no judge involved); links settled by the
ladder / by the judge / missed; judge calls (the price of candidate generation); per category and per rung (`score.ts`, unit-tested in
`test/entity-resolution-score.unit-spec.ts`).

## Measured

### 2026-11-02 — the nightly dedup blocks on names too

The nightly dedup pass proposed a pair only when the two entities' name embeddings cleared
cosine 0.92, the signal `common/name-key.ts` measures unable to separate a namesake from a
transliteration. It now runs the same string scans as the inline resolver
(`entity-candidates.service.ts`) for every seed, ahead of the cosine. And a word or name
part carried by two entities already joined by `identity_of` counts as one identity, so a
surname the pass has unified (`Alexander Volkov` = `Александр Волков`) still blocks the
next `Sasha Volkov`.

|                            | pairwise P | pairwise R | pairwise F1 | B³ F1 | judge calls | nights |
| -------------------------- | ---------- | ---------- | ----------- | ----- | ----------- | ------ |
| deferred, cosine-only pass | 100%       | 41.3%      | 58.5%       | 80.7% | 3           | 1      |
| **deferred, this change**  | **100%**   | **97.8%**  | **98.9%**   | 99.1% | 25          | 3      |

A keyless or harness install now reaches what a perfect judge reaches at ingest (oracle
below: 97.8% recall, 39 calls), in three nights. The stub embedder makes the cosine-only
row a floor: with bge-m3 the old pass would find some cross-script pairs by meaning, never
nicknames, initials or a namesake-free surname.

### 2026-11-02 — multi-pass candidate generation (main + this change)

The judge used to be shown ONE candidate: the first blocking scan that found anything
(key distance → name part → embedding) ended the search. Now every scan proposes at most
one entity and the judge is asked about each in turn until it says `same`; two scans were
added — initials (`IBM` ↔ `International Business Machines`) and a shared word no other
entity carries (the surname: `Bob King` ↔ `Robert King`, `Sasha Volkov` ↔ `Alexander
Volkov`, `Жуан Силва` ↔ `João Silva`). A scan runs only when every candidate before it was
refused.

|                   | pairwise P | pairwise R | pairwise F1 | B³ F1 | auto-merge P | links: ladder / judge / missed | judge calls |
| ----------------- | ---------- | ---------- | ----------- | ----- | ------------ | ------------------------------ | ----------- |
| judge off         | 100%       | 41.3%      | 58.5%       | 80.7% | 100% (15/15) | 15 / 0 / 16                    | 0           |
| oracle, before    | 100%       | 84.8%      | 91.8%       | 94.7% | 100% (15/15) | 15 / 11 / 5                    | 33          |
| **oracle, after** | **100%**   | **97.8%**  | **98.9%**   | 99.1% | 100% (15/15) | 15 / 15 / 1                    | 39          |

The ceiling a judge can reach rose by 13 points of recall for 6 more verdicts (+18%) over
56 mentions. The one link left is the code path ↔ symbol pair, which needs
`INGEST_CODE_ALIAS_RESOLUTION` (off by default). With the judge off nothing changes: the
same-name contradiction check (`same-name-conflict.ts`) already keeps the three namesake
pairs apart, and no candidate is merged without a verdict.

### 2026-11-01 — main @ code defaults, SurrealDB 3.2.4 stand

|              | pairwise P | pairwise R | pairwise F1 | B³ F1 | auto-merge P      | links: ladder / judge / missed |
| ------------ | ---------- | ---------- | ----------- | ----- | ----------------- | ------------------------------ |
| judge off    | 70.4%      | 41.3%      | 52.1%       | 77.9% | **83.3%** (15/18) | 15 / 0 / 16                    |
| judge oracle | 100%       | 84.8%      | 91.8%       | 94.7% | 100% (15/15)      | 15 / 11 / 5                    |

Findings:

1. **With no judge, a same-name stranger is merged.** All three `same-name-different`
   mentions (the second John Smith, Maria Gonzalez, Elena Rossi — contradicting role,
   city and birth year) landed on the first person's entity via `exact`. The
   contradiction check (#815/#821, `confirmSameName`) only runs when the judge is
   available; otherwise the first candidate is reused. In harness mode and on a keyless
   install, that fuses two people's memory. With the oracle the three stay apart.
2. **Keyless recall stops at exact keys.** Transliterations whose keys differ by a letter
   (`Мария Петрова` → `mariya petrova` vs `maria petrova`, `Artyom`/`Артём`) are
   neighbours for the judge, not key hits: 4 of 11 `translit` links join with the judge
   off, 10 of 11 with it. The Portuguese article (`o Banco Inter`) is not an
   `article-variant`; only the judge joins it.
3. **What no judge can reach, because no candidate is surfaced:** nicknames (Bob King,
   Sasha Volkov), the abbreviation IBM, `Жуан Силва` (key distance past the ceiling),
   and the code path ↔ symbol pair (`INGEST_CODE_ALIAS_RESOLUTION` is off by default).
   With bge-m3 the embedding scan may surface some of these; this battery runs the stub.
