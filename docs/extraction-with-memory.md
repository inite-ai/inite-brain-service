# Extraction with memory

How a turn becomes facts when the graph already holds something about
it — the write-path contract between the extractor, the memory it reads,
and the persisters.

## Why

A turn extracted in isolation makes the graph incoherent in ways no
later pass repairs. Measured on an 11-turn business dialogue
(2026-09-18): the same budget landed on two subjects across turns (a
"pilot" in turn 1, the client in turn 4), the same attribute under two
predicate names (`planned_start` / `start_month`), a moved date beside
the old one with both active, a first name filed as a second person,
generic nouns (the report, the board, Friday) minted as entities — one
of which cross-linked two projects and produced a false answer — and
every deadline date lost because the date lane only resolved the past.

Every memory system that works makes the decision that needs judgement
— *is this the same attribute of the same thing, and does it replace
what we hold?* — once, in the model that reads the sentence, with the
memory in front of it (Mem0's add/update over retrieved memories,
Graphiti's extractor over the episode's existing nodes and edges). Brain
does the same: the extractor reads the memory around the turn and
answers those questions in its output.

## What the extractor reads

`MemoryContextService` (`src/ingest/memory-context.service.ts`) builds
the context before every extraction, on both ingest paths (the document
path a stock deployment routes mentions through, and the direct mention
path):

| Section | Source | Cap |
|---|---|---|
| `TURN DATE` | the turn's `occurredAt` | — |
| `CONVERSATION SO FAR` | the conversation's earlier `episode` rows (index `conversationId, occurredAt`), oldest first, without the turn itself | 6 turns |
| `KNOWN ENTITIES [e#]` | local-NER names of the turn, the earlier turns and the participants, each through the resolver's **read-only** lookup (exact / transliteration key / article / code alias — no embedding, no judge) | 10 |
| `KNOWN FACTS [m#]` | active + competing facts of those entities, user-fenced | 12 per entity |
| `KNOWN PREDICATES` | the tenant's predicates by usage (`GROUP BY predicate`), cached a minute per tenant | 40 |

The read is a few indexed queries and the NER pass (already cached per
text for the extractor's own pre-pass) — ~20–30 ms. Any failure degrades
to a smaller context; the date alone still anchors the turn.

The rendered sections precede the turn in the user message
(`renderMemoryContext`); the system prompt carries the contract
(`MEMORY_CONTRACT_SECTION`, appended to both extraction headers). The
extraction cache key includes a digest of the context, so the same
sentence read against a different memory is extracted again.

## What the extractor returns

Three fields on top of the existing entity/fact/edge schema, required by
the strict JSON schema in lockstep with the prompt:

- `entities[].known` — the handle of the KNOWN ENTITY this mention
  refers to ("Rui" after "Rui Almeida", a transliteration, a role the
  conversation tied to a person), else `null`. The parser maps the handle
  to the `knowledge_entity` id; an invented handle maps to nothing. The
  upsert ladder files a pinned mention under that entity directly
  (step 1a, audit `matchKind: 'known'`), stamping the surface form as an
  alias so the next exact lookup needs no model. A pinned entity is
  grounded by construction — the extractor writes the known name for a
  short mention, and the span gate must not drop it.
- `facts[].supersedes` — handles of KNOWN FACTS this fact replaces: a new
  value of the same attribute, a moved date, a changed state — whatever
  predicate the old row was spelled under. After `fn::resolve_fact`
  inserts the fact, `FactResolverService.applyExplicitSupersession`
  closes those rows with the fn's own supersede shape (`status`,
  `retractionReason`, `retractedBy`, `supersededBy`, `priorValidUntil`,
  `validUntil` — never before the loser's own `validFrom`), flips a
  winner the fn had left COMPETING to active, and folds the outcome into
  the result so telemetry, support edges and the trace read SUPERSEDED.
  The slot machinery inside the fn still runs first, for facts that name
  nothing.
- `facts[].eventTime` — the calendar day (YYYY-MM-DD) the value refers
  to, resolved by the model against the turn date, any language. A day
  at or before the turn is an occurrence and becomes `validFrom`; a day
  after it is a scheduled thing (a deadline, a meeting, a launch) and the
  fact stays valid from the moment it was said. Either way the day rides
  the row as `objectMeta.date`, rendered on evidence lines as
  `(on YYYY-MM-DD)` and fed to the computed date table, so the read side
  never parses "19 сентября" again. The chrono lane (`event-time.ts`)
  remains the fallback for a fact without a day.

Two policies ride the same contract:

- **Entities are named things.** A generic noun, a role, a date or an
  unnamed thing becomes the value of a fact on the named entity it
  belongs to — a KNOWN ENTITY, one the turn names, or the speaker. Only
  when the turn names nothing and no speaker is known does the described
  thing become the entity, so the fact is never lost.
- **Standing instructions have a predicate.** An instruction to the
  assistant ("запомни: …", "always …", "write reports for X in
  Portuguese") is filed under `instruction`. The T7 instruction lane
  reads that predicate directly (`InstructionLaneService`) instead of
  running a second search over trigger words.

## Both ingest paths

The document path threads the turn's participants through the internal
document meta (`speakerName` / `speakerRef` / `addresseeName` /
`addresseeRef`), so the extractor's coreference framing and the commit
writer's externalRef anchor apply there exactly as on the direct path.
Candidate rows carry `known`, `eventTime` and `supersedes`; the
cross-indexer merge keeps `known`, takes `eventTime` from the leader and
unions `supersedes`.

## Relations are citable

An edge is knowledge with a record behind it. Search hits carry the
edge id and its direction on every relation, and the answer plane
renders a relation as `[r2] A — kind → B` (an incoming edge reads in
its own direction — the peer is the subject). The generator cites it
like a fact; the citation's `factId` is the `knowledge_edge` id. Such an
answer is served fresh (the answer cache tracks fact lifecycles only)
and the outcome ledger records fact citations only.

## Serving: the revision round

Under strict guardrails a `partial` verdict used to null the whole
answer for one sentence the auditor would not carry. The audit stage
(`src/synthesize/revise-round.ts`) now runs the verifier, and on a
partial verdict whose evidence answers the question, regenerates ONCE
with the previous answer and the named claims in front of the generator
(`REVISION` frame), then re-verifies. The auditor is told the query's
date, and layout, calendar placement relative to that date and
statements about what the evidence lacks are not claims.
