# Multi-vector memory — per-modality embedding spaces (2026-08)

Design for the retrieval half of the multimodal Evidence Plane: how non-text observations
get dense representations, which embedding spaces those live in, what it costs, and why
this is **deliberately a design doc and not a build** (§6). Companion to
[brain-v21-2026-08.md](brain-v21-2026-08.md) (the v2.1 wave this belongs to) and
[multilingual-2026-08.md](multilingual-2026-08.md) (whose Tier 2 built the space machinery
this design reuses wholesale). The one-line thesis: **a modality is just another embedding
space, and 0101 already knows how to name, stamp, fence, and migrate spaces — so
multi-vector memory is a registry and a lane, not a substrate.**

## 1. What already exists (each verified on main)

| Piece                                                                                     | Where                                                                       | What it gives this design                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Canonical space id `provider:model:dim:norm`                                              | `src/ai/embedder/embedding-space.ts:54`                                     | One naming scheme for every space, text or not                                  |
| `spacesCompatible` / `describeSpaceIncompatibility`                                       | `src/ai/embedder/embedding-space.ts:107`                                    | A guard that refuses cross-space compares instead of silently scoring noise     |
| Per-row `embeddingSpaceId` on all embedding-bearing tables + per-tenant cutover state     | `src/db/migrations/0101_embedding_space.surql` (state table at `:88`)       | Row-level space provenance; dual-write + atomic cutover protocol                |
| `EMBEDDING_TABLES` inventory                                                              | `src/ai/embedder/embedding-space.ts:143`                                    | The single list the reindex sweep walks                                         |
| `EmbedderService.activeSpaceId()` (+ the `FactEmbeddingService` facade)                   | `src/ai/embedder.service.ts:279`, `src/ingest/fact-embedding.service.ts:30` | The active-space resolver every writer already consults                         |
| `derived_representation` with `kind='embedding'`, `embeddingSpaceId`, and a vector column | `src/db/migrations/0109_evidence_substrate.surql:175,181,186`               | The storage seat — reserved in 0109 precisely so this design needs no migration |
| The dense-leg read shape (`vector::distance::knn()` projection)                           | `src/search/internals/legs.ts:142`                                          | The KNN idiom any new lane copies verbatim                                      |

Two spaces ship today, both text: `openai:text-embedding-3-small:1536:l2` and
`bge-m3:Xenova/bge-m3:1024:l2`. A tenant is wholly in one space at query time — never
mixed — and the 0109 `embedding` column on `derived_representation` is **write-dead**: the
migration comment names this doc as the unlock.

## 2. The design: one space per modality, fenced by 0101

The single-active-space assumption relaxes to a per-tenant **modality map**
(`modality → embeddingSpaceId`, modalities from `EVIDENCE_MODALITIES`,
`src/common/evidence-taxonomy.ts:8`). Nothing else changes shape:

- **Naming.** A CLIP-class image space is just a new canonical id (e.g.
  `clip:ViT-L-14:768:l2`); an audio-embedding space likewise. No new descriptor format.
- **State.** `embedding_space_state` today models one `activeSpace` plus one migration
  `targetSpace` (0101). The modality map extends that row with additive `option<>` fields —
  the same table, the same dual-write/cut-over protocol per modality.
- **Storage.** Non-text vectors live in `derived_representation` rows (`kind='embedding'`,
  `subjectKind` asset|fragment), each stamped with its space. Heterogeneous dims coexist in
  one table because every compare is fenced by `spacesCompatible` — a wrong-space candidate
  is dropped, never scored.
- **Retrieval.** One dense leg per targeted modality: the query embeds through that space's
  query tower, the leg runs the standard KNN projection, and legs fuse by RRF exactly like
  today's lanes. The retrieval profile decides the fan-out per query class — no new config
  surface.
- **Versioning.** A representation producer re-run deletes its own `producerVersion` rows
  and reinserts (the 0106 segmenter idiom, already in 0109); scene fingerprints already
  embed the active space id into effective versions (`src/admin/scene-version.ts:62`), so a
  space flip forces re-derivation instead of silently mixing worlds.

Three candidate architectures, ranked:

| Option                    | Shape                                                                                | Verdict                     |
| ------------------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| **A. Text-proxy**         | Captions / OCR / ASR text embedded in the EXISTING text space — zero new spaces      | **v1 — the bar to beat**    |
| **B. Joint dual-encoder** | CLIP-class shared space per modality pair; text queries embed through the text tower | v2 candidate, measured vs A |
| **C. Late interaction**   | N token/patch vectors per fragment + MaxSim                                          | Parked (§4)                 |

## 3. Why option A is the bar

The substrate already produces text derived representations (`caption`/`ocr`/`asr` kinds,
0109), and embedding them rides the entire existing dense stack: same embedder, same
space, same reindex sweep, same HNSW legs, zero new query cost — it is just more text.
Our lever history also says selection, not representation, dominates misses (the ablation
mining in the research program), so the class option B uniquely fixes — queries where the
text proxy is _lossy_ ("what color was the chart", speaker identity from voice) — is real
but unmeasured. Doctrine: **A ships with the fragment retrieval lane (MM-2); B is built
only when a paid eval shows the proxy-lossy class matters in a consumer workload.**

## 4. Late interaction (option C) — recorded and parked

What it buys: sub-fragment precision — MaxSim over token/patch vectors finds the sentence
inside a page or the region inside a frame without pre-cutting finer fragments. Why it is
parked:

- **Storage shape.** N vectors per row does not fit `option<array<float>>`; it needs
  per-vector rows or nested arrays plus custom scoring — and SurrealDB has no native
  MaxSim, so scoring runs TS-side over candidate sets, the exact full-scan class the
  `vector::distance::knn()` idiom exists to avoid.
- **Index cost.** HNSW entries multiply by the per-fragment vector count (32–128×); the
  cost model (§5) puts a 100k-fragment tenant at tens of GB of vectors alone.
- **Cheaper substitute.** Fragments are already locators (charRange / pageRegion /
  timeRange) — cutting finer fragments where precision matters buys most of the win inside
  the single-vector model.

Bar to revisit: a live fragment lane whose pooled vectors measurably fail on
span-precision questions.

## 5. Cost model (estimates, f64 array storage)

| Configuration                                      | Per-fragment vector payload  | 100k fragments | Query-side delta                       |
| -------------------------------------------------- | ---------------------------- | -------------- | -------------------------------------- |
| A. Text-proxy (reuses text space, 1536-dim)        | ~12 KB (rides existing rows) | ~1.2 GB        | none (existing lanes)                  |
| B. One joint space, 768-dim, 1 vector/fragment     | ~6 KB                        | ~0.6 GB        | +1 embed + 1 KNN leg per modality      |
| C. Late interaction, 768-dim × 64 vectors/fragment | ~0.4 MB                      | ~40 GB         | +1 embed + candidate fetch + TS MaxSim |

Production cost: option A rides the embed budget already paid for facts and segments;
option B needs a self-hosted tower (the bge-m3 ONNX worker precedent) or a paid API call
per asset; option C multiplies B's production cost by the vector count. Index memory adds
one HNSW index per (table, space) — linear in rows, dominated by the vector payload above.
GDPR is free everywhere: vectors ride `derived_representation` rows, which already die in
the evidence cascade.

## 6. Why NOT built yet

1. **No producer.** No real ASR/OCR/vision adapter exists — MM-1 ships the broker seam,
   and real adapters are on the v2.1 not-yet list. An image space with nothing embedded is
   dead weight.
2. **No consumer.** No serving path reads the 0109 tables (the substrate's pinned shadow
   guarantee); the fragment lane is MM-2, in flight. A lane-less space cannot even be
   mis-measured.
3. **Measurement is parked.** The paid-eval program is frozen, and §3's A-vs-B question is
   precisely a measurement question. Building B before it can be scored strict-currency
   would violate the house rule that levers are measured before they earn defaults.
4. **Multi-active-space state is a small but real build.** Extending
   `embedding_space_state` to a modality map touches the cutover protocol; not worth
   landing ahead of the first non-text space that would use it.
5. **The reserved seat is the plan working as intended.** 0109 pre-paid the schema
   (`embedding` + `embeddingSpaceId` on `derived_representation`) so that when this design
   builds, it is flags + a registry entry — no migration, no backfill.

## 7. Build shape when it lands

A `MULTI_VECTOR_`-free build: the registry rides the existing `EMBEDDING_` family
(`EMBEDDING_MODALITY_SPACES` naming the map, default off), the lane rides MM-2's fragment
lane flag, and `EMBEDDING_TABLES` gains a `derived_representation` entry only if a plain
re-embed producer exists — modality vectors otherwise re-derive through their own producer,
the `community_node` precedent already documented at
`src/ai/embedder/embedding-space.ts:137`. Serving guards reuse `spacesCompatible`
verbatim; the migration count is zero.
