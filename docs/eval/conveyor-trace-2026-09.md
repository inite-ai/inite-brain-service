# The conveyor, traced end to end — 2026-09-16

`pnpm eval:conveyor` walks every declared stage of `src/conveyor` against a
live server with `X-Brain-Debug: 1` on every request and grades each stage
by the trace footprint it leaves. This is the first time the whole chain
was run **as the deployed assembly** — the deploy workflow's own
enablement env (149 keys) plus the compose values, `bge-m3`, per-tenant
SurrealDB 3.2.4 — rather than as a stand with a hand-picked handful of
flags. The difference turned out to be the finding.

## The path that ships is not the path that was measured

The deploy sets `INGEST_MENTION_VIA_DOCUMENT=1`: every `/v1/ingest/mention`
goes through the document pipeline (source_document → indexer → candidates
→ commit), not through `MentionIngestService` / `MentionPersistService`.
Every ingest-side measurement in this repo's eval batteries — including the
multilingual Tier-0 run two days ago — exercised the other path.

First run on the prod assembly, four turns in three scripts (`report-U`):

| plane | after 4 turns | declared gate |
|---|---|---|
| `episode` (L0 turns) | **0** | `capture: always` |
| `scene_dirty_conversation` | 0 | — |
| `memory_episode` / `semantic_belief` | 0 / 0 | `SCENES_*=1`, `BELIEFS_*=1` |
| `knowledge_fact.validFrom` | all = the day it was SAID | `INGEST_EVENT_TIME_EXTRACTION=1` |
| `debug_trace` (`DEBUG_TRACE_PERSIST=1`) | **0**, one warning per request | — |

Four joins, each broken on the shipped path only:

1. **No L0 episode.** The wrapper documented it: *"no L0 episode turn is
   captured — the stored document is the raw observation instead."* True
   for the evidence plane; false for every plane that reads episodes.
   Scene segmentation, belief promotion, the transcript sections of an
   answer and the L3 anchors were all switched on in prod and had nothing
   to read, because the only writer of their input lived on the path the
   deployment does not run.
2. **No event time.** `INGEST_EVENT_TIME_EXTRACTION=1` in the deploy; its
   only reader was `MentionPersistService.factValidFrom`. The document
   commit stamped `doc.occurredAt` on every fact. "Пилотный запуск
   запланирован на 3 марта 2026" → `validFrom = 2026-09-16`. The ICU date
   work measured at temporal 1.00 was not on the conveyor.
3. **The judge saw facts, not edges.** `incomingFactsFor` rendered an
   entity's facts only. The fix that took cross-script linking to 1.00 on
   the mention path (edges as evidence) had no counterpart here.
4. **Traces never persisted.** `CREATE debug_trace` passed `ts` as an ISO
   string and `errored: null`; SurrealDB 3.x refuses both (`Expected
   datetime`, `Expected none | object but found NULL`). Every trace logged
   "persist failed" since the 3.x move. No unit spec could see it — they
   fake the store — and no e2e ever sent `X-Brain-Debug`, because the
   fixture did not install the middleware.

Plus one at the door: a fresh tenant's first document write raced its own
schema provisioning and surfaced as a 500 (`Transaction conflict: Resource
busy. This transaction can be retried`). The retry helper existed and was
not on that call.

## What changed

- `MentionViaDocumentService` captures the episode first, exactly as the
  direct path does (same fail-closed rule), and the id rides the internal
  document channel (`episodeId`, `timezone` — two new brain-owned keys)
  onto every committed fact's `source.episodeIds`.
- `factValidFrom` / `resolveEventTimeOpts` moved into `event-time.ts` and
  both paths call the one function. The trace artifact
  `ingest.fact.event_time` fires on either.
- `incomingFactsFor` renders relations as `kind: other`, same as the
  mention path.
- `debug_trace` persist casts `<datetime>$ts` and omits an absent error.
  Pinned by `test/conveyor-joins.e2e-spec.ts` against a real store; the
  e2e fixture now installs `debugTraceMiddleware` like `main.ts`.
- `retryOnReadConflict` (conflicts only — a unique violation on a bare
  CREATE is an answer, and the store has a dedupe branch for it) wraps the
  `source_document` create.
- `EpisodeStoreService` moved to `IngestCoreModule`, where the other write
  primitives live, so the documents module can reach it without a cycle.
- `INGEST_INLINE_RESOLUTION_HNSW=1` dropped from the deploy env — the flag
  was deleted with the scan it gated.

## Stages that left no trace

The check is only as good as the trace, and several stages had none. The
resolver's ladder settled an entity without saying which rung; the judge's
span carried no attributes; the answer cache's hit/miss/store lived only in
a metric; the conformal guardrail logged at debug only when it dropped
something; episode capture was silent. Each now leaves one artifact:

| artifact | carries |
|---|---|
| `ingest.episode.captured` | episodeId, conversationId, messageId |
| `ingest.entity.resolution` | name, type, **step** (hint / exact / article-variant / translit / code-alias / judge / created), entityId |
| `ingest.entity.judge` | both names, candidate + how it was found (translit / embedding) + cosine, both sides' evidence, verdict, decision |
| `synthesize.answer_cache` | decision (bypass / hit / miss / stored / not_admitted / rejected_stale) |
| `synthesize.guardrail` | floors, kept, dropped |

## The run after (`report-W`, prod assembly)

Every `always` stage of all three conveyors has a footprint; every join
check passes:

| check | result |
|---|---|
| one node across Cyrillic, Latin and Han | ✓ — Артём Соколов: `created`; Artem Sokolov: `translit`; 阿尔乔姆·索科洛夫: `judge → same`; 波尔图 → Porto: `judge → same` |
| event time | ✓ — `pilot_launch_date=2026-03-03`, the correction `2026-04-09` |
| capture | ✓ — 4/4 turns are episodes; the scene pass composed 1 scene, the belief pass created 2 beliefs with 2 support edges |
| relations on the hit | ✓ — 3/4 hits |
| synthesize | ✓ — «9 апреля 2026» in Russian with the March date as history; Porto; abstains on salary (`no_grounded_evidence`); verifier `supported` |
| answer cache | ✓ — first ask `miss, stored`; repeat `hit` in 25 ms |
| traces | ✓ — 11/11 listed for the tenant, persisted |

Reported as gated off, correctly: `6 PPR` (`SEARCH_PPR_ENABLED=0` in the
deploy) and `6b` verbatim segment leg (`shape_conditioned`; none of these
queries has the shape).

## Still open, seen on the same trace

- The extractor (gpt-4o-mini, prod's `OPENAI_CHAT_MODEL`) minted «3 марта
  2026» as a `topic` entity and wrote `Helio Robotics works_at Helio
  Robotics`, `Helio Robotics owns Artem Sokolov`, `3 марта 2026
  scheduled_for 3 марта 2026`. Self-referential facts are noise by
  construction; whether a structural filter belongs at the commit is a
  separate decision.
- A fact's object is a string, not a link: `located_in: 波尔图` and
  `located_in: Porto` land as **competing** values of one slot although
  the entity ladder resolved 波尔图 to Porto in the same request. Value
  identity across scripts is the next Tier.
- `works_as` holds «ведущий инженер», "lead engineer" and the Chinese
  rendering as three active values — the same statement in three
  languages, and the slot policy cannot tell.
- `knownEntities` hints still do not reach the document path's resolver.
- The stand runs without the NLI router and local NER (laptop memory);
  the prod run covers those.
