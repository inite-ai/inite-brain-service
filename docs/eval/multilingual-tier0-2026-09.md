# Multilingual Tier 0: the first live run, and what it found

The multilingual matrix (`test/eval/multilingual/`) had existed for weeks
and had never been run against the real system — `RealModel.predict`
threw, so every number it had ever produced came from a stub deriving
predictions from the case's own gold. Tier 0 is the gate the roadmap puts
in front of every `MULTILINGUAL_*` behaviour flip, and nothing had passed
through it because nothing had been measured.

Run live for the first time on 2026-09-14. 28 of 28 cases drivable, none
skipped.

## What the eleven language lanes are worth

Measured as two assemblies rather than eleven flags — arm **S** the
shipped system, arm **M** the same plus every `MULTILINGUAL_*` lane
together, because the roadmap specifies them as a chain (attribution
feeds the confidence gates, which feed the soft filter and the lane
router, which feed the answer guard).

| metric                                       | S           | M    | Δ     |
| -------------------------------------------- | ----------- | ---- | ----- |
| recall@1 / recall@3 / ndcg@10                | 1.00 (n=11) | 1.00 | **0** |
| extraction-f1                                | 0.20 (n=5)  | 0.20 | **0** |
| entity-linking-accuracy                      | 0.33 (n=9)  | 0.33 | **0** |
| fragmentation-rate                           | 0.67 (n=3)  | 0.67 | **0** |
| temporal-exact-day                           | 0.57 (n=7)  | 0.57 | **0** |
| answer-language-correctness                  | 0.75 (n=12) | 0.83 | +0.08 |
| abstention-ece / over-reject / hallucination | 0.00        | 0.00 | **0** |

Ten of eleven metrics do not move. The one that does moves by a single
case out of twelve. Sample sizes run from 1 to 12 per metric, so this is
a first reading and not a verdict — but nothing in it supports the eleven
lanes being the answer to anything the matrix measures.

**Cross-lingual retrieval, the failure the whole programme was aimed at,
is already perfect**: recall@1 = 1.00 across ru↔en and de/es/zh/ar/hi→en.

## The measurement error in that table

Arm S was labelled "the shipped assembly" and was not. It ran with
`INGEST_INLINE_RESOLUTION_ENABLED` **off** and the openai embedder, while
production's `enablement.env` has resolution **on** and
`EMBEDDER_PROVIDER=bge-m3`. So `entity-linking-accuracy = 0.33` measured a
configuration nobody deploys — with resolution off there is no
cross-script linking mechanism running at all, and four surfaces
producing four nodes is the arithmetic of that, not a finding.

The finding survived the correction anyway, for a different reason. See
below.

## What is actually broken

### 1. Absolute dates die in any locale chrono cannot read

```
ml.temp.ar   "٣ مارس ٢٠٢٦"   ->  2026-09-14      gold 2026-03-03
ml.temp.hi   "3 मार्च 2026"    ->  2026-09-14      gold 2026-03-03
```

Not "off by a bit" — six months wrong, and wrong in the shape that reads
as an answer: `resolveEventTime` returns null and the caller stamps the
message time, so a miss is indistinguishable from a resolution.

`chrono-node` ships parsers for thirteen languages. Everything else falls
back to `chrono.en`, which parses nothing at all in a non-Latin script.
Confirmed directly against chrono: ru/de/es/zh all resolve correctly;
ar and hi produce no parse in any parser.

**Fixed** (`src/ingest/locale-date.ts`): month names are read out of ICU
via `Intl.DateTimeFormat`, pinned to `-u-ca-gregory-nu-latn` so `th` does
not answer in the Buddhist era and `fa` in the Persian calendar. The
format context gives the inflected form a date actually contains — ru
"марта", pl "marca", cs "března", uk "березня" — not the nominative a
standalone lookup returns. Where a locale glues a proclitic to the month
(he "3 **ב**מרץ 2026") the prefix is taken from ICU's own literal.

Covers every locale ICU knows, which is far more than the two that
exposed it: th, he, fa, tr, id, pl, cs, uk had no chrono parser either
and were failing the same silent way. Conservative by construction — a
match needs a month NAME, a day and a four-digit YEAR, so "we may go"
cannot parse as May and "31 February" is refused rather than rolled into
March.

`MULTILINGUAL_TEMPORAL` is **deleted**. It gated two things, and both are
already expressed by inputs rather than by an operator decision: the
relative grammar is keyed by the clause's own language (a map lookup that
misses for every other language), and the day-shift fix only applies when
the caller supplies `dto.timezone`.

### 2. Inline entity resolution was dead on every per-user tenant

The candidate scan fenced `knowledge_fact` on `userId IS NONE`, mirroring
the wording of the canonical-name fence in `entity-upsert`. But there it
fences `knowledge_entity`, where `userId` means _this entity is private to
one user_; here it fenced the FACT, where `userId` means _this is who said
it_. Mention ingest stamps the speaker onto every fact it writes while
leaving the entity tenant-global, so on any per-user-scoped tenant every
`name` fact carried a userId, the scan matched none of them, and inline
resolution resolved nothing at all — for every name, in every language.

**Fixed**: the fence is `entityId.userId IS NONE`, which is the privacy
property that was meant. A private entity still never matches; a global
one is reachable through whoever happened to name it.

### 3. An embedding cannot decide whether two names are the same name

Everything past the exact-string match was left to cosine + an LLM judge.
Measured on bge-m3 — the provider prod runs — over `name: <surface>`:

| same person / company        | cos   |     | different things               | cos       |
| ---------------------------- | ----- | --- | ------------------------------ | --------- |
| Ivan Petrov ~ Иван Петров    | 0.865 |     | Ivan Petrov ~ Maria Alvarez    | 0.445     |
| 伊万·彼得罗夫 ~ إيفان بيتروف | 0.825 |     | Ivan Petrov ~ Thomas Brandt    | 0.484     |
| Ivan Petrov ~ 伊万·彼得罗夫  | 0.767 |     | Ivan Petrov ~ 李伟             | 0.449     |
| Aarav Sharma ~ आरव शर्मा     | 0.748 |     | **Ivan Petrov ~ Иван Сидоров** | **0.712** |
| Ivan Petrov ~ إيفان بيتروف   | 0.739 |     |                                |           |
| Иван Петров ~ إيفان بيتروف   | 0.695 |     |                                |           |
| Orbital Dynamics ~ … GmbH    | 0.880 |     |                                |           |

A **different person** who happens to share a given name scores above
four of the six true cross-script pairs. The bands overlap, so no
threshold separates them and no amount of tuning will produce one.

That is not a mistuned floor. An embedding measures MEANING and a name
does not have one — to that model "Ivan Petrov" and "Иван Сидоров" both
mean _a Russian man's name_, and it is answering that question correctly.
It is the wrong question. Names are settled orthographically, by writing
both spellings in one script:

```
Иван Петров  -> ivan petrov   == Ivan Petrov  -> ivan petrov     same
Иван Сидоров -> ivan sidorov  != Ivan Petrov  -> ivan petrov     different
```

Deterministic, reversible, free, and right on the exact pair the
embedding gets wrong.

**Fixed** (migration 0148, `src/common/name-key.ts`): `nameKeys` on
`knowledge_entity` holds the transliteration of every spelling the entity
is known by, folded to letters and digits. The match ladder gains a
deterministic step between the exact-string match and the probabilistic
resolver, and it fills `matchKind: 'translit'` — a value the merge log
has always declared and nothing has ever produced.

Transliteration data is `any-ascii`, a port of the Unicode tables:
platform data of the same kind as the ICU month names above, not a table
maintained here by hand.

The cosine floor becomes a RECALL floor (0.85 → 0.65), because the judge
is the decider and a candidate it never receives is decided by a number
that provably cannot decide it.

#### What the key deliberately refuses

- **Anything under three characters after folding.** `C`, `C++` and `C#`
  all fold to `c`. On a code corpus that is a wrong merge waiting for its
  first mention, and nothing downstream can undo a name whose
  distinguishing characters were thrown away.
- **Anything with no letter or digit.** any-ascii transliterates an emoji
  to its CLDR name — `🙂` becomes `slight smile`, a perfectly good key and
  an entirely fake identity.
- **A native spelling against an arbitrary human romanization.** any-ascii
  renders Ё as "e"; a person may well have typed "Yo". GOST, BGN/PCGN and
  ISO 9 disagree about Ё, so this is a property of the problem.
- **Scripts that write a foreign name by sound.** 伊万·彼得罗夫 →
  `yiwan bideluofu`, إيفان بيتروف → `yfn bytrwf`, आरव शर्मा → `arv srma`.

The last two are what the embedding + judge path is _for_. The point of
the deterministic layer is that they are now the only thing left in it:
cases a string comparison can settle no longer go to an LLM to be guessed
at.

### 3b. The embedding scan had never had anything to scan

With the key in place, the scan behind it was found empty. Both embedding
consumers — inline resolution and the off-hours dreams dedup — searched
`knowledge_fact WHERE predicate = 'name'`. Measured on a live tenant on
2026-09-16: 33 entities, 80 facts, **zero** with predicate `name`.
Nothing on the free-text mention path writes one; a `name` fact only
arrives through structured `POST /v1/ingest/fact`. The resolver's own
doc names the mention path as the only path it serves.

So every "embedding + judge" resolution that was supposed to have
happened on a mention-ingested corpus never did, and prod has carried
`INGEST_INLINE_RESOLUTION_ENABLED=1` doing exactly that. The dreams
dedup found zero seeds on every sweep.

Meanwhile `knowledge_entity.embedding` has existed since the 0001
baseline — described in 0101 as "the entity-name/description vector",
with the reindex sweep already knowing to rebuild it from
`name: <canonicalName>` "per the confirmed write path" — and had never
had a writer. **Fixed**: the ingest path embeds the name at entity
creation (through the space guard, stamping `embeddingSpaceId`), and
both scans read the entity column. No new column; the dead one got its
purpose. The fact-index KNN leg and `INGEST_INLINE_RESOLUTION_HNSW` went
with the fact scan.

### 3c. The judge was deciding on half the evidence

Three things the judge could not see, each found by watching it refuse a
pair it should have accepted:

- **The names.** It received two fact lists and a number, never the two
  surface strings — so for one person in two scripts, whose facts are
  the same facts in two languages, it saw no shared evidence at all.
- **The incoming entity's edges.** The extractor files "works at Orbital
  Dynamics" as a fact in one language and as an edge in another; the
  judge read only facts, and compared a full profile against a role
  and nothing else.
- **The existing entity's facts, on any per-user tenant.** `fetchTopFacts`
  carried the same speaker fence as the resolver's scan, and returned
  "(no facts)" for every entity.

**Fixed**: the judge is handed both names, told which scan produced the
candidate and what that number means, and both sides' facts and edges.
Its rule was also made explicit: facts in different languages that say
the same thing are matching facts, and a residual spelling difference
after transliteration (a surname that differs by an ending) still marks
a possible different person unless a fact beyond the employer agrees.

Judge model matters, and it was measured three ways on the same matrix:

| judge                                     | entity-linking | fragmentation | notes                                                                                           |
| ----------------------------------------- | -------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `gpt-4o-mini` (what prod's chat model is) | 0.56           | 0.57          | "different" on 3 of 9 same-role-same-employer cross-script pairs; changes its mind between runs |
| `gpt-4o`                                  | 0.89           | 0.25          | consistent, 9/9, two runs                                                                       |
| **`gpt-5.6-luna`**                        | **1.00**       | **0.00**      | every merge audited correct, every refusal correct; 0 reasoning tokens at `low` effort          |

`gpt-5.6-luna` is the cost tier of the newest generation ($0.20 / $1.20
per 1M, July 2026; `gpt-5.4-nano` is the same price a generation older,
`gpt-5-nano` is a quarter of it and eighteen months older). It is now the
judge's own default (`ENTITY_JUDGE_MODEL` overrides), and the judge no
longer inherits `OPENAI_CHAT_MODEL`.

Calling it needed a fix of its own: the judge hand-rolled
`temperature: 0, max_completion_tokens: 64`, which a gpt-5.x model
answers with **400** ("'temperature' does not support 0 with this
model") — and a model that accepted it would spend the 64 tokens on
hidden reasoning and return an empty message. Both parse as "unsure".
The judge now goes through the shared reasoning guard (`chatCallParams`)
at `low` effort, which for this one-token verdict costs nothing extra.

A spelling the judge has confirmed is stamped into `nameKeys` on the
way out, so the next mention of it resolves deterministically instead of
paying the scan and the call again.

## After the fixes

Same matrix, prod-parity flags, bge-m3, judge `gpt-5.6-luna`:

| metric                      | first run   | after    | what moved it                                                              |
| --------------------------- | ----------- | -------- | -------------------------------------------------------------------------- |
| entity-linking-accuracy     | 0.33 (n=9)  | **1.00** | name key + live embedding scan + judge evidence + judge model              |
| fragmentation-rate          | 0.67 (n=3)  | **0.00** | same                                                                       |
| temporal-exact-day          | 0.57 (n=7)  | **1.00** | ICU-derived absolute dates; the Russian carrier said "launch of the pilot" |
| extraction-f1               | 0.20 (n=5)  | **0.70** | gold corrected to the native surfaces                                      |
| answer-language-correctness | 0.75 (n=12) | **0.92** | the detector counted characters; the verifier dropped translations         |
| over-reject-rate            | 0.00 (n=11) | 0.00     | —                                                                          |
| recall@1 / @3 / ndcg@10     | 1.00        | 1.00     | —                                                                          |

Ivan Petrov, written in Latin, Cyrillic, Han and Arabic, is **one node**:
Latin↔Cyrillic met on the transliterated key, Han and Arabic came in
through the embedding scan at cosine 0.767 and 0.739 — the same numbers
the isolated measurement predicted. Across the whole run: 27 merges, all
audited correct (seven spellings each of Maria Alvarez, Thomas Brandt
and Nadia Haddad into one entity apiece); 8 refusals, all correct
(Пётр ≠ سمير, Ivan Petrov ≠ Пётр, Aarav Sharma ≠ سمير). Ten staff
entities for the ten distinct people the corpus names.

### 5. The language detector counted characters

Every answer the brain produces ends in a citation, and on a Chinese
answer that citation alone is 34 Latin letters against 15 Han ones. The
detector called it English with confidence 0 — the matrix's own copy
of the detector agreed — and `answer-language-correctness` reported 0.00
for zh/mono on an answer that read "Orbital Dynamics 的工程负责人是玛丽亚·
阿尔瓦雷斯". A Han character is a word; an alphabetic script spends five
or six letters on one.

**Fixed**: words, not characters, by ICU segmentation (UAX #29 via
`Intl.Segmenter`), with citations, URLs and bare identifiers stripped
first — they are text in no language. The matrix's second detector is
gone; it wraps the brain's. Known limit, pinned: an English sentence
quoting a Han-scripted name verbatim reads as Chinese.

### 6. The verifier treated a translation as a hallucination

Reproduced three of three: English question over Russian facts, the
generator answered correctly with the right citation, and the verifier
returned "unsupported" because the evidence said "руководитель
инженерного отдела" and the answer said "leads engineering". The answer
was dropped; the caller got nothing. **Fixed**: the verifier is told
that a faithful translation of evidence is supported by it, and that
wording repeated from the query ("at Orbital Dynamics") is framing, not
a claim. The false-premise query is still refused.

The one answer-language miss left is es/cross, where the generator wrote
"María Álvarez leads engineering at Orbital Dynamics as directora de
ingeniería" — English with the Spanish title quoted verbatim — and the
stopword vote on twelve mixed words landed on Portuguese. n=1, and the
answer is defensible.

## Still open

- Graph EDGES are not evidence to the answer plane: `SearchHit` carries
  facts only, so a relation the extractor filed as an edge ("works at
  Orbital Dynamics" for Maria, in Russian) is invisible to both the
  generator and the verifier. The verifier's query-framing rule covers
  the measured case; the gap itself is a retrieval change.
- The judge flips on "Orbital Dynamics GmbH" vs "Orbital Dynamics"
  between runs. A legal suffix is a defensible "different"; the gold
  says "same". n=1.
- `MULTILINGUAL_ANSWER_GUARD`'s fallback order (explicit → session
  locale → confidently detected → none) is plainly better reasoning than
  the default's "detect and force at any confidence", but with the
  detector fixed the metric sits at 0.92 either way and n=12 cannot
  separate them.
- The corpus is small: three role candidates, n = 1…12 per metric. Before
  anything is deleted on the strength of these numbers, it needs widening.
- Existing tenants need the backfill once:
  `POST /v1/admin/maintenance/entities/backfill-name-keys`. It stamps
  both `nameKeys` and the name embedding; until it runs, pre-existing
  entities are found by the exact-name path only, as before.
