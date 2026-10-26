# Trust circles — memory scoped to who was in the room (2026-10-26)

Question asked: _the relationship layer is one case of something more
general — trust circles. A person's private memory, their line with a
coach, a facilitated group, the tenant: each is a circle, and memory
must stay in the circle it was said in unless someone explicitly moves
it. What does the architecture need?_

Answer in one line: **the skeleton exists — per-row `scope` tags, a
fail-closed evaluator, Zanzibar membership tuples with timestamped
revocation and a `scope_epoch` consistency token. What is missing:
a native `circle:` namespace, agents as principals (today an M2M key is
tenant-wide), reads bound to ONE acting circle rather than the union of
memberships, writes stamped by the conversation's circle rather than the
speaker, derivation that inherits the narrowest scope, lifecycle that
never crosses circles, an extraction context fenced like a read, and
explicit share acts with consent.**

Relation to [the relationship layer](relationship-layer-2026-10.md): a
relationship is the circle {person, counterpart}. Its §2.2 "consent
bound to purpose" is implemented by this document; its plan's step 2
points here.

Status: concept, grounded in the code at `origin/main` 03f1c684.
Nothing here is built.

---

## 1. The model

| Circle                            | Members                   |
| --------------------------------- | ------------------------- |
| private memory                    | {Ana}                     |
| a relationship                    | {Ana, coach}              |
| a private line with a facilitator | {Ana, Irishka}            |
| a facilitated group               | {Ana, Bob, Vika, Irishka} |
| the tenant                        | everyone                  |

Every row belongs to the circle it was said in. Moving it to another
circle is an act with a record, never a re-tag.

Three rules carry the design:

1. **A read is bound to one circle.** A principal that belongs to many
   circles reads, per request, the one it is acting in — never the
   union. A facilitator speaking in the group does not read the private
   lines it also holds.
2. **What is derived from several circles is visible only where all of
   them are.** The narrowest scope wins.
3. **Nothing crosses a circle by itself.** Not a fact, not a
   supersession, not a summary, not an extraction context.

## 2. What exists

| Piece                  | Where                                              | What it gives                                                                                                                                                            |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scope` tag column     | migration `0093`                                   | an AND-set of `<namespace>:<id>` tags on `knowledge_fact`, `knowledge_entity`, `knowledge_edge`, `episode`, `episode_segment`; `[]` = tenant-global                      |
| evaluator              | `src/auth/scope-visibility.ts`                     | `visibleUnderScope`: clause ⊆ held tags; unknown/unparseable tag hides the row; behind `SCOPE_TAGS_ENABLED`, composed with AND over the `userId` fence (can only narrow) |
| held tags per request  | `src/auth/scope-principal.ts`                      | expansion resolved once by the guard, read synchronously by every SQL fence; a miss falls back to `user:<id>` (narrower, never wider)                                    |
| membership             | migration `0169`, `src/auth/membership.service.ts` | `external_principal` tuples (`subject member object`), nesting with a depth bound, `revokedAt` instead of delete, `scope_epoch` bumped on every change                   |
| acting client identity | `extractActorId`, `src/auth/claim-parsers.ts:108`  | RFC 8693 `act` → `client_id`; drives `mcp_agent:<id>` attribution and `agent:<id>` policies                                                                              |

## 3. What changes

### 3.1 A native `circle:` namespace

`external_principal.object` is `team:<connection>:<group>` and
`relation` admits only `member`: groups exist only as mirrors of a
source system. Circles are brain's own:

- tag `circle:<id>`; tuples written by brain (`source: 'brain'`), not by
  a connector sync;
- relations `member` (a person) and `agent` (an agent or a human
  facilitator acting in the circle);
- a person's private memory is the implicit circle `user:<id>` — no
  migration of existing rows.

### 3.2 Agents are principals

Today an M2M credential with no end user is `TENANT_WIDE`: it sees every
row in the tenant. That is why the relationship battery's R3 leaks by
construction — the coach and the assistant are both M2M keys.

- `actorId` (or the static key's id when there is none) becomes the
  principal `agent:<id>`, a member of specific circles;
- an agent acting for a user sees the intersection: what the user may
  see ∩ the circles the agent belongs to;
- `TENANT_WIDE` stays for operator and background contexts, and for
  existing clients until they opt in (§5).

### 3.3 The acting circle

Each request names the circle it acts in — an MCP/REST parameter, or a
binding `conversationId → circle` registered once. The guard checks
membership and leaves the circle in the request context; the fences
read the circle's tag (plus explicit shares into it), not the
principal's whole expansion. A request without a circle behaves as
today.

This is the rule that keeps a facilitator honest by construction rather
than by prompt.

### 3.4 Writes stamped by the conversation's circle

A turn's facts are scoped today by the `userId` passed on ingest — the
speaker. In a group, each of Bob's lines would be visible to Bob alone
and the group would have no shared memory at all. Under a circle, the
episode and everything extracted from it carry the acting circle's tag;
`userId` still records who spoke.

### 3.5 Derivation inherits the narrowest scope

Anything computed from rows of several circles is scoped to the AND of
their tags. Gaps today:

| Surface                                           | Gap                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `semantic_belief`                                 | no `scope` column, no row policy (`src/beliefs/beliefs.service.ts`, header)                                                                                                     |
| answer cache                                      | keyed by `userId` (`src/answer-cache/dependencies.ts:266`) — two agents of one user with different circles would share a cached answer; key on the held tag set + `scope_epoch` |
| `conversation_digest`                             | its own `userScopes` mechanism, outside the tag grammar (0093 says so)                                                                                                          |
| scenes, community summaries, dreams, user profile | built per tenant or per user, not per circle                                                                                                                                    |

### 3.6 Lifecycle stays inside a circle

If a group fact supersedes a private one, the coach in {Ana, coach}
loses the private fact and cannot see what replaced it, and the closure
itself reveals that something was said in the group. Rule: supersede,
corroborate and competing act only between rows of identical scope. A
disagreement between circles is two truths, each true in its circle.

### 3.7 The extraction context is a read

`src/ingest/memory-context.service.ts` puts KNOWN ENTITIES / FACTS /
edges into the extractor's prompt under a `userId` gate. In a group it
would show the speaker's private facts to the extractor, which can copy
them into group-scoped facts or supersede them from a group turn — a
leak no read fence catches, because the laundering happens on write. It
must be fenced by the acting circle, exactly like a search.

### 3.8 Sharing is an act

Moving something to another circle creates a new row there with
`derived_from` the source and a consent record (who authorised it, when,
for which circle and purpose). Revoking retracts the copy and bumps the
epoch. The original is never re-tagged: a re-tag loses the history and
widens access silently. An "anonymised" mention in a group is a share
too.

### 3.9 Attribution — R5 is a prerequisite

In a group people talk about each other. Bob's guess about Ana must stay
Bob's statement in the group's circle — never a fact on Ana's entity
that then surfaces in her profile or her coach's brief. The relationship
battery's baseline found the extractor doing exactly that with a
coach's question (§5.1 there). Fixing it comes before groups.

### 3.10 Entities carry no content

The entity node "Ana" is shared tenant-wide as identity — merging across
circles is fine. Everything that says something about her lives in
scoped facts and edges. A canonical name learned in one circle is the
one exception worth a decision (§6).

## 4. Measurement

The relationship battery grows a group corpus — four participants, a
facilitator, private lines beside the group — with mechanical checks:

| #   | Check                       | Pass condition                                                                                          |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| C1  | Private line stays private  | a disclosure in {Ana, Irishka} is absent from every read acting in the group                            |
| C2  | Group stays in the group    | a group disclosure is absent for an agent outside the circle                                            |
| C3  | Derived stays narrow        | a belief / summary / cached answer built from a private line never serves in the group                  |
| C4  | No cross-circle lifecycle   | a group fact contradicting a private one leaves the private one active in its circle                    |
| C5  | Extraction does not launder | extracting a group turn never writes a fact whose text came from a private-line fact                    |
| C6  | Share and revoke            | an explicit share appears in the target circle with its consent record; after revoke it is gone at once |
| C7  | Others' guesses stay theirs | Bob's guess about Ana is not served as a fact about Ana, in any circle                                  |

## 5. Plan

| Step | Builds                                                                                | Exit                                                                |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0    | R5 fix in the extractor (§3.9)                                                        | relationship R5 green; memory-fitness / state-transitions at parity |
| 1    | agents as principals + acting circle (§3.2, §3.3); opt-in per key                     | relationship R3 green; existing clients unchanged                   |
| 2    | `circle:` namespace + conversation binding + write stamping (§3.1, §3.4)              | C1, C2 green                                                        |
| 3    | narrowest-scope derivation, in-circle lifecycle, fenced extraction context (§3.5–3.7) | C3, C4, C5 green                                                    |
| 4    | share acts with consent (§3.8)                                                        | C6 green; relationship R6 green                                     |
| —    | C7 rides on step 0                                                                    | —                                                                   |

Compatibility: every step is inert for a request that names no circle
and a key that has not opted in, the same way `SCOPE_TAGS_ENABLED` was
introduced — it can only narrow.

## 6. Open questions

- Where the acting circle comes from for clients that cannot pass a
  parameter (Claude, ChatGPT connectors): a per-key default circle, or
  the conversation binding only?
- A name learned in one circle: does the entity's canonical name follow
  it everywhere (low risk, high convenience), or only inside the circle?
- Tenant-wide operator views (admin UI, GDPR forget) keep
  `TENANT_WIDE`; analytics over circles must be content-free, like
  `tool_observation`.
- Group size and churn: a member who leaves keeps reading what was said
  while they were in? Bitemporal membership says the question is
  answerable; the product has to choose.
