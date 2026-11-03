# Lexical-stems battery

Measures the stemmed lexical field (migration 0184, #892). The lexical legs
match a word by its stem in the row's own language, next to the unchanged
unstemmed indexes.

The battery is free: no model, no key, no stand. It needs one SurrealDB.

## Data

[MIRACL](https://project-miracl.github.io/) (Apache 2.0) dev queries with
human relevance judgements, as published for MTEB reranking
(`huggingface.co/datasets/mteb/MIRACLReranking`). For each language the
sample is seeded: N dev queries that have a relevant passage, plus every
candidate passage MTEB lists for them, pooled into one corpus. Each query
retrieves from the whole pool.

```
# download {lang}-{corpus,queries,qrels,top_ranked}/dev-00000-of-00001.parquet
# as {lang}-{part}.parquet into one directory, then:
python prepare.py <parquet dir> <sample dir> [50]     # needs pyarrow
SURREALDB_URL=ws://… SURREALDB_USERNAME=root SURREALDB_PASSWORD=root \
SURREALDB_NAMESPACE=brain OPENAI_API_KEY=unused MIRACL_SAMPLE_DIR=<sample dir> \
  pnpm eval:lexical-stems [--langs=ru,es]
```

`OPENAI_API_KEY` only satisfies boot validation; nothing calls a model.

## What runs

- **Leg:** the real episode lexical leg, `EpisodeReadStoreService.searchText`
  with `buildLexMatchLeg` in the L3 anchor shape, against every migration.
- **Two arms per query:** `plain` (no stem field) and `stem` (`textStem`
  added).
- **Language stamps:** a passage's language comes from the production
  detector, not from MIRACL, so detector misses count.
- **Query language:** the detector's when it is confident, else the
  tenant's (`fn::tenant_lang`).
- **Tenants:** each language is its own tenant.

## Result (2026-11-03, 50 queries × 10 languages, ~5,000 passages each)

| lang | queries placed by the detector | nDCG@10 plain → stem | R@100 plain → stem |
| ---- | ------------------------------ | -------------------- | ------------------ |
| ru   | 50/50                          | 0.276 → **0.310**    | 0.923 → **0.993**  |
| en   | 11/50                          | 0.290 → **0.308**    | 0.907 → **0.975**  |
| de   | 3/50                           | 0.220 → **0.253**    | 0.950 → **0.990**  |
| fr   | 0/50                           | 0.145 → **0.180**    | 0.910 → **0.950**  |
| es   | 6/50                           | 0.236 → 0.223        | 0.866 → **0.963**  |
| ar   | 50/50                          | 0.417 → **0.479**    | 1.000 → 1.000      |
| zh   | 50/50                          | 0.000 → **0.226**    | 0.010 → **1.000**  |
| ja   | 50/50                          | 0.033 → **0.277**    | 0.147 → **0.983**  |
| ko   | 50/50                          | 0.308 → **0.400**    | 0.751 → **0.980**  |
| hi   | 50/50                          | 0.363 → 0.363        | 0.939 → 0.939      |

Recall@100 rises in every language that has an analyzer. nDCG@10 rises
everywhere except Spanish, which falls by 0.013. That is inside the noise
of 50 queries, and Spanish recall rises by 0.10. Hindi has no Snowball
stemmer, so its arms are identical, as designed.

How the result changed while the battery was being built:

- **Unplaced queries.** On the first run only queries the detector placed
  were stemmed. That is 0–11 of 50 for short Latin questions (French is
  read as Spanish more often than as French), so es, fr, de and en barely
  moved. Falling back to the tenant's language lifted all four.
- **CJK.** A CJK question is one run of characters with no spaces. Its
  bigrams were first ANDed, so nothing matched (zh 0.000 → 0.000). Matching
  them with OR (`@N,OR@`) fixed it.
- **The `plain` arm.** It already uses the any-script term split this
  change introduces. Before it, terms split on `[^a-z0-9а-яё]`, which
  dropped every CJK, Arabic and Devanagari word and cut accented Latin
  words. Hindi went from 0.054 to 0.363 once combining marks counted as
  part of a word. The true baseline before this change is therefore lower
  than the `plain` column for zh, ja, ko, ar and hi.

Measured locally against a SurrealDB 3.2.4 capped at 2 CPUs and 4 GB, on
disk. The 200-query sample (about 20,000 passages per language) took the
in-memory server past its memory, so this run used 50 queries.
