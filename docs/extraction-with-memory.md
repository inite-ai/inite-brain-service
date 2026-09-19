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
— _is this the same attribute of the same thing, and does it replace
what we hold?_ — once, in the model that reads the sentence, with the
memory in front of it (Mem0's add/update over retrieved memories,
Graphiti's extractor over the episode's existing nodes and edges). Brain
does the same: the extractor reads the memory around the turn and
answers those questions in its output.

## What the extractor reads

`MemoryContextService` (`src/ingest/memory-context.service.ts`) builds
the context before every extraction, on both ingest paths (the document
path a stock deployment routes mentions through, and the direct mention
path):

| Section                       | Source                                                                                                                                                                                              | Cap           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `TURN DATE`                   | the turn's `occurredAt`                                                                                                                                                                             | —             |
| `CONVERSATION SO FAR`         | the conversation's earlier `episode` rows (index `conversationId, occurredAt`), oldest first, without the turn itself                                                                               | 6 turns       |
| `KNOWN ENTITIES [e#]`         | local-NER names of the turn, the earlier turns and the participants, each through the resolver's **read-only** lookup (exact / transliteration key / article / code alias — no embedding, no judge) | 10            |
| `KNOWN FACTS [m#]`            | active + competing facts of those entities, user-fenced                                                                                                                                             | 12 per entity |
| relations, same `[m#]` series | the entities' live edges (`invalidatedAt IS NONE`), rendered in their own direction (`e2 — runs_on → Fly.io`, `Pedro Lima — covers_for → e1`)                                                       | 8 per entity  |
| `KNOWN PREDICATES`            | the tenant's predicates by usage (`GROUP BY predicate`), cached per tenant until the tenant's next commit                                                                                           | 40            |

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
- `facts[].supersedes` — handles of KNOWN FACTS and relations this fact
  replaces: a new value of the same attribute, a moved date, a changed
  state, the edge that stated the old value — whatever predicate the old
  row was spelled under. After `fn::resolve_fact` inserts the fact,
  `FactResolverService.applyExplicitSupersession` closes those rows with
  the fn's own supersede shape (`status`, `retractionReason`,
  `retractedBy`, `supersededBy`, `priorValidUntil`, `validUntil` — never
  before the loser's own `validFrom`), flips a winner the fn had left
  COMPETING to active, and folds the outcome into the result so
  telemetry, support edges and the trace read SUPERSEDED. A named edge
  gets `invalidatedAt` = the new value's day (never before it was
  written) — the fence every edge read runs behind — so "moved to
  Hetzner" retires `runs_on → Fly.io` instead of leaving it beside the
  new value on every read. The slot machinery inside the fn still runs
  first, for facts that name nothing.
- `facts[].eventTime` — the calendar day (YYYY-MM-DD) the value refers
  to, resolved by the model against the turn date, any language. A day
  at or before the turn is an occurrence and becomes `validFrom`; a day
  after it is a scheduled thing (a deadline, a meeting, a launch) and the
  fact stays valid from the moment it was said. Either way the day rides
  the row as `objectMeta.date`, rendered on evidence lines as
  `(on YYYY-MM-DD)` and fed to the computed date table, so the read side
  never parses "19 сентября" again. The chrono lane (`event-time.ts`)
  remains the fallback for a fact without a day.

- `facts[].cardinality` — `one` or `many`: can the subject hold several
  values of this attribute at once? A novel predicate the turn coins
  registers with that reading (`one` → `single_active`, `many` →
  `append_only`; `PredicateRegistryService.canonicalize` takes it in the
  context object) and the semantics judge is not asked; a predicate
  already registered keeps its semantics. The judge remains for writers
  without the contract (`record_fact`, the harvest lanes). Measured on
  the stand: the judge was 1–3.6 s of every turn that coined something,
  in series after the extraction, on a tenant young enough that every
  turn did — ingest fell from 2.6–10.9 s to 2.0–6.6 s per turn with the
  extractor deciding. On the same 17 coinages the extractor agreed with
  the judge on 12 and read `one` where the judge read `many` on the
  rest (an event, a responsibility, an intent); the contract wording
  names those classes and ties break to `many`. `instruction` is seeded
  `append_only` in the core vocabulary — its cardinality is part of the
  contract, not a per-turn reading.

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

## The user in the memory

A mention's `userId` scopes what it writes (0055); it also says who is
talking. A user-scoped mention with no `speaker` anchor is the user's
own turn — their side of a conversation with their assistant, their
notes — so the ingest path puts the user among the participants before
anything reads them (`participants.ts`, `UserEntityService.participants`):
the episode's `speaker`, the extractor's framing ("This turn is by X, the
user this memory belongs to … 'I' and 'the user' refer to X; words the
turn attributes to someone else are that person's") and the entity
anchor all see the same speaker. A declared speaker always wins, so a
caller relaying someone else's words under the user's scope says so.

The user's entity is an external reference like any other — vertical
`user`, id = the userId (the namespace the scope-tag grammar reserves
for end users) — under the user's OWN scope: a personal entity, visible
to the user alone, deleted with their memory on forget. Both paths mint
it through the same scoped key (`scopedRefKey`), so a first-person turn
and a typed fact on `{vertical: 'user', id: <userId>}` land on one node.
**Its name is memory, not a claim.** A credential says who the subject
is (`sub`/`org`); what they are called the memory learns — the way Zep's
user node carries a summary the graph builds and Letta's `human` block
is written by the agent as it learns, not read off a login. The user's
entity is born named by the userId (a reference id is not a name) and
its canonical name follows its current `name` fact (`entity-name.ts`,
one UPDATE in the fact resolver's post-write tail): the fact the
extractor files when the user says who they are ("Я Саша", "this is
Mike"), or the fact a client writes at onboarding —
`record_fact({entityRef: {vertical: 'user', id}, predicate: 'name',
object, userId})`, the same node. The old name stays an alias. The rule
is narrow: an entity minted from a name keeps it; only one still named
by its reference id, or the user's own entity, follows the fact. The
caller's speaker anchor with a `name` names the entity directly as well
(`nameParticipant`). The memory context pins the user's entity as KNOWN
on every turn of theirs, resolved by its key, never by name, so "I moved
to Berlin" closes `lives_in: Riga` on the right node.

**Onboarding is the memory saying what it lacks.** `workspace_status`
(`user.name`, a `nextSteps` entry), `GET /v1/users/:userId/profile`
(`identity`, the first line of `profileText`) and the Claude Code hook's
session-start context all say when the memory has not learned the
user's name, and what write records it — the agent asks once, the answer
becomes a `name` fact, and everything downstream follows.

At ask time the same entity is the **asker** (`synthesize/asker.ts`),
resolved beside the main search and BEFORE the evidence renders: its
fact and relation lines are headed `you` instead of its name (subject or
relation peer, `buildFactIndex`), and the generator, the auditor and the
L3 round get the same line — "you" is the person asking (with the name
when the memory has one), the query's first person is them, answer in
the second person. The link is structural, so it holds before any name
is known. Before this the auditor rejected "Do I own the Riga apartment?"
over evidence filed on Sasha with, verbatim, "evidence attributes
ownership to Sasha, not to the user".

## Both ingest paths

The document path threads the turn's participants through the internal
document meta (`speakerName` / `speakerRef` / `addresseeName` /
`addresseeRef`; `participantsFromMeta` reads them back), so the
extractor's coreference framing and the commit writer's externalRef
anchor apply there exactly as on the direct path (`coreferentParticipant`
is the one coreference rule both use).
Candidate rows carry `known`, `eventTime` and `supersedes`; the
cross-indexer merge keeps `known`, takes `eventTime` from the leader and
unions `supersedes`.

## Reading history

A fact that superseded an older value carries the story on its evidence
line — `(previously: <value> — until <date>)`, built from the reverse
`supersededBy` links (`UpdateStoryService`) — and, with facts-as-keys,
one verbatim quote of its grounding turn. Both suffixes, and the belief
damping pass, key on the fact id; the rendered line opens with a handle
(`[f3]`, #613), so every consumer resolves the line through
`lineFactId` (fact-index.ts). Between #613 and this fix nothing matched
and a history question ("как менялся бюджет") could not see the old
value at all.

## Relations are citable

An edge is knowledge with a record behind it. Search hits carry the
edge id and its direction on every relation, and the answer plane
renders a relation as `[r2] A — kind → B` (an incoming edge reads in
its own direction — the peer is the subject); an edge the search
returns on both of its endpoints renders once. The generator cites it
like a fact; the citation's `factId` is the `knowledge_edge` id. The
answer cache tracks the edge as a dependency arm (`kind: 'edge'`, 0152 —
revalidated on every read against `invalidatedAt` and the edge fence),
so a relation answer is cached like any other; the outcome ledger
records fact citations only.

An edge is as personal as the facts of its turn. A user-scoped turn
stamps its edges with the same `userId` its facts get (0153), and every
relation read — the search lanes, the answer plane's evidence, the
connections surface, the memory the extractor is shown — runs behind
the fail-closed edge fence: tenant-global edges for everyone, a user's
own edges for that user only. Uniqueness is per scope (0154:
`(in, out, kind, scopeKey)`, where `scopeKey` is the row's own fold of
`userId ?? ''` — SurrealDB does not enforce a unique key with a NONE
component), so the tenant-global "Maria — works_at → Orbital" and a
user's personal one are two rows that never stand in for each other.
Tenant-wide structures — communities — are built from tenant-global
edges only.

## Serving: the revision round

Under strict guardrails a `partial` verdict used to null the whole
answer for one sentence the auditor would not carry. The audit stage
(`src/synthesize/revise-round.ts`) now runs the verifier, and on a
partial verdict whose evidence answers the question, regenerates ONCE
with the previous answer and the named claims in front of the generator
(`REVISION` frame), then re-verifies. The auditor is told the query's
date, and layout, calendar placement relative to that date and
statements about what the evidence lacks are not claims.
