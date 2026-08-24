# Multilingual / cross-lingual memory — research memo + spec-leaning roadmap (2026-08, v3)

> **Status: research memo, approaching a working spec — not yet a committed build
> plan.** v1 doubled as a build plan; two internal review passes corrected the work
> ordering and the technical premises (v2), then a third pass (2026-08-24) added the
> parts that make it *implementation-ready*: **measurable Tier-0 gates**, **language-
> metadata + embedding-space migration protocols**, **reversible entity resolution**,
> and a correct decomposition of locale time parsing. This v3 folds those in. Every
> "our code" claim is anchored to a verified `file:line`; every SOTA claim is
> labelled component-benchmark evidence, **not** memory-QA evidence.

## Release posture (unchanged, load-bearing)

- **Release 2 may ship only with multilingual scoped as `experimental`** — no public
  promise of full language support.
- If Release 2 were advertised as multilingual, the current hard same-language
  filters + zero confidence-hygiene on language labels would be a **product blocker**.
- The document becomes a working spec once Tier-0 gates, the migration protocols, and
  reversible entity resolution below are accepted.

## Correction v3 makes to its own thesis: it is **not** "only the read side breaks"

v2 said the substrate is right and only read-side glue breaks. That is too
optimistic. Three language-sensitive decisions happen at **ingest / write time**, and
a bad write is **baked into the substrate** — far harder to undo than a read miss:
- **Entity identity** is decided at write: `ingest/entity-resolver.service.ts:95`
  `resolveByName` returns an existing entity id on a confident match and the caller
  **reuses it immediately** — a cross-script miss (Москва vs Moscow) fragments a node,
  and a wrong "same" verdict **merges irreversibly** (no candidate/merge record).
- **Temporal anchoring** is decided at write: `ingest/event-time.ts:84` normalises the
  anchor to **UTC midnight** (`atUtcMidnight` via `getUTC*`), which can shift the
  calendar day for a non-UTC locale before any relative expression is even parsed.
- **The `lang` label** is stamped at write from a short `object`
  (`ingest/fact-resolver.service.ts:212`) by a detector that returns `en` at ~zero
  confidence for short Latin strings (Gap 0). A wrong label is then persisted.

So the roadmap must include **write-side correctness + migration**, not only a
read-side boost.

## Gap 0 (the P1) — unreliable language attribution, trusted blindly at read

- `ai/locale/language-detector.ts:307` `scoreLatinLanguage`: `bestLang` initialises to
  `'en'`, moves only on a stopword hit → a short Latin token (`Berlin`, a name, an SKU)
  returns **`en`** with a near-zero score.
- Two read sites apply that label as a **hard** filter, **ignoring confidence**:
  - `search/search.service.ts:123` `resolveLangFilter` (backs off only on exact `und`),
    feeding `search/internals/where-builder.ts:152` `AND (lang = $q OR lang IS NONE)`.
  - **`users/user-profile.service.ts:195`** — the *same* `(lang = $langFilter OR lang
    IS NONE)` idiom on the user-profile read surface (v2 missed this second site).

## The gaps (ranked) — unchanged from v2 in substance, with the new detail folded in

| # | Gap (verified in code) | Fix direction | Tier |
|---|---|---|---|
| 0 | Language attribution unreliable; two read sites hard-filter on it ignoring confidence (`language-detector.ts:307`, `search.service.ts:123`, `where-builder.ts:152`, `user-profile.service.ts:195`) | confidence-aware attribution + soft boost (below) | 1 |
| 1 | Same-language hard filter hides the user's own cross-lingual facts (XOR-TyDi asymmetric case, [2010.11856](https://arxiv.org/abs/2010.11856)) | hard `AND` → confidence-gated **boost**, at **both** filter sites | 1 |
| 2 | Default embedder is *not* non-cross-lingual (OpenAI 3-small = 44.0 MIRACL); bge-m3 is not a free default — it is an **embedding-space migration** (`embedder.service.ts` 1024 vs 1536 during warmup; `reindex-engine.service.ts` rewrites only `knowledge_fact`; `hnsw-maintenance.service.ts:33` leaves other tables stale) | A/B, then the **migration protocol** below | 2 |
| 3 | Entity identity fragments across scripts and merges irreversibly (`entity-resolver.service.ts:95`) | **reversible** resolution (below); translit/embedding = *candidate*, not auto-merge | 3 |
| 4 | Byte-sensitive keys + homoglyph surface; locale-blind casefold | explicit **identifier policy** (below); UTS-39 skeleton = **risk signal only** | 3 |
| 5 | Locale time/number handling (`event-time.ts:84` UTC-midnight shift; ar/hi/ko → English chrono) | **decompose** (below); ICU/CLDR is *not* a full NL time parser | 4 |
| 6 | mention-scan degraded for CJK (`mention-scan.ts:110` Latin+Cyrillic only); "contradiction" conflates write-side adjudication with presentation (`answer-router.ts:516`) | ICU segmentation; **NLI / typed-value** comparison, never embedding cosine | 4 |
| 7 | Grounding/abstention calibration doesn't transfer across languages (NoMIRACL [2312.11361](https://arxiv.org/abs/2312.11361)) | per-language calibration with **hierarchical fallback** | 5 |
| 8 | Answer-language confusion; synthesis is already `temperature: 0` (`generator-client.ts:148`) | answer-language **fallback ordering** (below) — never fact-driven | 5 |
| 9 | The RU↔EN smoke set (`eval/scenarios/multilingual.scenarios.ts`) is not representative | the **measurable Tier-0 matrix** (below) | 0 |
| 10 | Code-switching defeats single-language routing | represent as `langs[]` / dominant+distribution, not a new `lang='mixed'` bucket | 1–2 |

## Tier 0 — the *measurable* gate (must exist before any behaviour flip)

Not "grow the smoke set" but a matrix with **languages, directions, and per-metric
thresholds**. Proposed starting set (tune before committing):

- **Languages:** en, ru, de, es, zh, ar, hi (Latin + Cyrillic + CJK + RTL + Devanagari
  — covers the script classes our lexical helpers break on).
- **Directions:** monolingual (store L, query L) **and** cross-lingual (store L₁, query
  L₂) for each pair that matters, with **language-neutral gold**.
- **Per-metric gates (illustrative targets — set real numbers from a baseline run):**

  | Dimension | Metric | Gate |
  |---|---|---|
  | Extraction | fact/entity **F1** vs gold, per language | no per-language regression vs en beyond X pp |
  | Entity linking | resolution **accuracy** + **fragmentation rate** (dupes/entity) | fragmentation ≤ baseline; no spurious merges |
  | Retrieval | **Recall@k / nDCG@k**, monolingual and cross-lingual | cross-lingual recall ≥ Y; monolingual non-regressing |
  | Temporal | **date-accuracy** (exact-day) per locale | off-by-day rate ≤ baseline |
  | Conflict / lane | **F1** of conflict detection + lane routing per language | ≥ en within Z pp |
  | Answer language | **answer-lang correctness** (detected == intended) | ≥ threshold under complex prompts |
  | Abstention | **ECE / over-reject vs hallucinate**, per language | calibrated within band per language |
  | Ops | **p95 latency**, **cost/query** | no regression beyond budget |

- **Telemetry (ship first, behaviour-neutral):** emit `lang` label + `langConfidence` +
  `langSource` + `detectorVersion` distributions so every later flip is *measured before
  flip*, honouring our own rule.

## Migration protocol A — language metadata (write-side, versioned + backfilled)

- Add **`langConfidence`**, **`langSource`**, and **`detectorVersion`** alongside `lang`.
- Split **`sourceLang`** (language of the source message/turn) from **`contentLang`**
  (language of the stored `object`) — they differ (a Russian turn stating an English
  brand name).
- Short / stopword-less / numeric tokens → **`und`, not `en`**; inherit `sourceLang`
  onto short objects **only where justified**, recorded via `langSource`.
- **Backfill** existing rows under a `detectorVersion` bump (re-run detection, stamp
  confidence/source), so old rows aren't silently trusted at the old label.
- Apply a same-language constraint **only at high confidence**, and as a **boost**, at
  **both** read sites (`where-builder.ts:152`, `user-profile.service.ts:195`).

## Migration protocol B — embedding space (zero-downtime, all tables)

- Stamp **`embeddingSpaceId`** (model + dim + normalisation) on **every** embedding-
  bearing record.
- **No failover between incompatible spaces** — the current warmup fallback
  (bge-m3 1024 ⇄ OpenAI 1536) must be replaced by "serve only the space the row was
  written in", or refuse.
- **Shadow dual-write / dual-read**, then an **atomic per-tenant cutover** (a tenant is
  wholly in one space; never mixed mid-query).
- **Reindex covers all** embedding tables — `knowledge_fact` **and** entities,
  predicates, episodes, segments, strategy memory — not just facts
  (`reindex-engine.service.ts` today rewrites only `knowledge_fact`).
- bge-m3 stays an **experiment** until A/B + this protocol land.

## Reversible entity resolution (write-side)

- **Strong key:** externalRef / QID **with a namespace + uniqueness constraint** —
  QIDs suit public entities, **not** private-tenant ones (clients, employees, internal
  projects), which need a tenant-namespaced external key.
- **Ordered candidate pipeline, each stage only *proposes*:** `externalRef/QID → exact
  alias → transliteration candidates → multilingual embedding → contextual judge →
  candidate merge`. Transliteration is a **candidate generator, not an identity key**
  (distinct names can share a transliteration; ICU: transliteration ≠ translation,
  [ICU guide](https://unicode-org.github.io/icu/userguide/transforms/general/)).
- **Reversibility:** `resolveByName` currently reuses the matched entity immediately
  (`entity-resolver.service.ts:95`) → record a **merge/candidate log** so a wrong merge
  can be split; do not auto-merge on transliteration/embedding alone. mGENRE's +50%
  ([2103.12528](https://arxiv.org/abs/2103.12528)) is multilingual-KB linking, not
  private-tenant memory.

## Locale time — decomposed (ICU/CLDR is not a full NL time parser)

Four separable concerns, currently conflated:
1. **NL relative-expression recognition** ("three weeks ago", "к пятнице") — a parser
   job (chrono-class), per language; ICU/CLDR does **not** do this.
2. **Calendar conversion** (Hijri / Jalali / 令和 / Buddhist+543) — ICU/CLDR territory.
3. **Locale-aware number parsing** (de `1.000,50` → 1000× error if mis-read).
4. **Timezone + ambiguous dates** (DMY/MDY; and `event-time.ts:84`'s **UTC-midnight**
   normalisation, which can shift the day for a non-UTC locale).
Store ISO-8601 + numeric in the language-neutral slots (the storage split already
exists); fix each concern separately.

## Answer-language — explicit fallback ordering (never fact-driven)

`explicit answerLang → user/session locale → confidently-detected query language → no
forced language`. On mixed retrieval the **facts must not** determine the answer
language (v2's "fall back to fact-language" was unsafe). Synthesis is already
`temperature: 0`; add an output-language check (detect answer lang, retry/flag on
mismatch).

## Identifier / homoglyph policy (precise)

- Casefold: default Unicode folding and **Turkic** folding differ (ı/İ, ß) — pick an
  **explicit identifier policy** per field, **preserve the original surface**, and use
  the folded form only as a match key.
- **UTS-39** ([tr39](https://www.unicode.org/reports/tr39/)) confusables **skeleton is
  a risk signal only** — it flags for review, it must **not** auto-block or auto-merge
  (Trojan Source [2111.00169](https://arxiv.org/abs/2111.00169) is about bidi
  source-code spoofing — a weak citation for this, kept only as background).

## Corrected roadmap (eval first; migrations explicit; entity resolution reversible)

- **Tier 0** — the measurable eval matrix + language telemetry (above). Behaviour-
  neutral; unblocks every later "measured before flip".
- **Tier 1** — confidence-aware language attribution (protocol A: confidence/source/
  version + backfill + sourceLang/contentLang) + same-language **boost** at both read
  sites. **No embedder change.**
- **Tier 2** — embedder A/B, then the zero-downtime space migration (protocol B).
- **Tier 3** — reversible entity resolution + Unicode identifier policy + CJK
  segmentation.
- **Tier 4** — multilingual lane classifier (reuse the cosine/centroid **primitive**
  from `common/vector-math`, **not** lens-suppression — subtractive by construction,
  `effectiveLanes ⊆ activeLanes`, cannot add a lane: `synthesize/lens-suppression.ts`);
  decomposed locale time; NLI / typed-value contradiction.
- **Tier 5** — hierarchical per-language calibration + answer-language guard.

## Honest caveats
- bge-m3 as default is a **behaviour + embedding-space change** → A/B + protocol B,
  never a bare flag flip.
- SOTA numbers are **component** benchmarks (retrieval / EL / QA / NLI), **not**
  memory-QA — transfer is plausible, unproven, unmeasured until the Tier-0 matrix runs.
- Verified premises: OpenAI 3-small 44.0 MIRACL
  ([OpenAI](https://openai.com/index/new-embedding-models-and-api-updates/)); bge-m3
  100+ languages ([2402.03216](https://arxiv.org/abs/2402.03216)); MKQA 2007.15207,
  mGENRE 2103.12528 (public-KB scope), NoMIRACL 2312.11361, XOR-TyDi 2010.11856,
  UTS-39 (homoglyphs).

**One-line takeaway:** the substrate is language-neutral enough to not *lose* data, but
identity, time, and language labels are decided at **write time** and the read side
then **trusts an unreliable label**; the safe path is measurable Tier-0 gates →
confidence-aware attribution + a same-language *boost* (both read sites) → a versioned
embedding-space migration → reversible entity resolution — each measured before flip,
multilingual staying **experimental** until those gates are green.
