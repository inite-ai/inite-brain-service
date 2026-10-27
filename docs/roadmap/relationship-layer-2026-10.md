# Relationship layer — memory of who the agent is talking to (2026-10-25)

Question asked: _empathy and relationship as a specialised memory layer on
top of brain, reachable by any agent over MCP — a dynamic model of the
person (who they are, what is happening to them now, what history the
agent and they share), portable between agents with consent._

Answer in one line: **most of the substrate exists — bitemporal facts with
`expectedUntil`, the belief plane, provenance and grounding, the user as an
entity of their own memory, W5 membership tuples, the media/biometric
tier. What is new is three things: the relationship as an object (user ×
counterpart), consent bound to purpose rather than to tenant/user/team,
and an outcome loop fed only by what the person says helped. Brain
returns evidence, never a behavioural recommendation: empathy is the
agent's behaviour, brain makes it consistent.**

Decisions taken (2026-10-25):

| Decision                 | Choice                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| First vertical           | Weight-loss coach — the Evolgevity _Weight & Mind_ programme (`~/Documents/beauty`, see §1.1) |
| Surfaces in v1           | Two from day one — the coach and a general assistant                                          |
| Voice                    | Voice with intonation (affect inferred from audio)                                            |
| Format                   | This document                                                                                 |
| Legal review             | The project owner (2026-10-26)                                                                |
| Step 0                   | Go (2026-10-26)                                                                               |
| Counterpart identity     | `actorId` (§2.1); a static key is its own counterpart                                         |
| Stated-affect shelf life | set by the extractor from the text (foresight); 24 h only as fallback                         |
| Read surface             | pack-declared tool + `brain://relationship/<userId>` resource for session-start injection     |
| Voice signal             | arousal/energy axes only, no discrete emotion labels; calibration gate before release         |

Status (2026-10-27): step 1 built on feat/trust-circles-agents — the R5
extraction fix, the `relationship` pack (0.2.0: commitments, open threads,
what helped, tone, stated affect, the hypothesis lifecycle),
`relationship_context` + `brain://relationship/<userId>`, and the trust
circles that keep the coach's line out of the assistant's reads
([trust-circles-2026-10.md](trust-circles-2026-10.md)). Literature cited in the source
discussion (ES-MemEval, RECALLbot, Memoria, APEX-MEM, EmoMem, CAMA) has
not been verified by us — check every reference before it goes into a
pitch.

---

## 1. What exists — mapped

| Concept                                         | Existing seam                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Observation with source, confidence, shelf life | fact + provenance + `groundingStatus` + valid time; `expectedUntil` (foresight, #687; `src/ingest/fact-expectation.ts`)         |
| "The user said" vs "the system inferred"        | fact plane vs belief plane (`src/beliefs/`, migration 0120); time arbitrates (#646)                                             |
| Current state, revisable                        | valid time + `asOf`; COMPETING for contradictory signals                                                                        |
| Episodes of interaction                         | episodes / scenes (`src/episodes/`, `src/scenes/`), `conversationId`, `memory_diff`                                             |
| The user as the centre                          | user entity `{user,<userId>}` (#640/#643); fail-closed user scope                                                               |
| Contextual trust                                | W5 membership plane (Zanzibar tuples, revocation by timestamp + `scope_epoch`); predicate fence `requiresScope: brain:read_pii` |
| Raw voice                                       | evidence plane, audio capability; media tier fails closed (`src/common/media-pii.ts`), `brain:read_media`                       |
| Remote processors                               | `EVIDENCE_PARSER_REMOTE` (W6) — our contract, operator's shim                                                                   |
| Explicit feedback                               | `record_feedback`, `record_decision`, procedural memory                                                                         |
| Pack-declared ontology + tools                  | domain packs, `docs/mcp-pack-tools.md`                                                                                          |

### 1.1 The first vertical already runs this pattern

The coach (`~/Documents/beauty`, Astro + SQLite, Telegram / Web Push /
e-mail, PT for São Paulo and EN for Dubai) keeps its own memory in
`person_memory`, in three layers the person can see, correct and delete
(`docs/evening-conversation.md` there):

| Coach layer                                             | Brain mapping                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| observation — what they said, dated                     | stated fact, grounded in the turn                                                                                |
| hypothesis — our guess, times seen, whether put to them | belief, with a lifecycle the coach already has and brain does not: **put to the person → confirmed or weakened** |
| confirmed — agreed in their own words                   | fact promoted only by the person's confirmation                                                                  |

And more of §2.1 is already live there: agreements from specialists'
sessions (`session_slots.notes` — commitments by a _human_ counterpart),
handoffs with a "by end of next day" promise (team commitments with a
due date), "tomorrow's action" agreed in the evening (a commitment), the
off-limits rule "never weight, diets, medication" (a boundary that must
hold in every surface), and a two-level safety pause released only by a
specialist.

What this changes:

- **Belief confirmation lifecycle** becomes part of step 1: a belief may
  carry `putToPerson: at`, and only the person's answer promotes it to a
  fact or weakens it. Brain's beliefs today are promoted by a pass, not
  by the person. _Built as pack facts, not beliefs:_ a guess put to the
  person is `relationship__hypothesis` (open) until their answer makes it
  `hypothesis_confirmed` or `hypothesis_rejected` (a later answer
  supersedes the open one); what they said in their own words is its own
  fact. The belief plane stays out — it has no scope column, so it
  cannot live in a circle.
- **Counterparts can be human.** A specialist recording what was agreed
  is a counterpart with commitments, like an agent.
- **Languages are PT + EN**, not RU + EN.
- **Voice stays design-only until the coach's own go.** Its decision rule
  puts voice (Telnyx) after a qualitative go on the text conversation,
  so step 5 is built and measured on synthetic audio first.
- **Not in the 1 November critical path.** The São Paulo group (~20
  people) starts 2026-11-01 on the coach's SQLite memory. Brain enters
  in shadow mode for the team's own test participant (separate start
  date, outside the group's numbers) under a consent that names brain as
  a processor — then for the group only after the battery is green and
  the privacy policy is updated.

Not to be confused: `src/outcomes/` (`memory_outcome`, `memory_decision`)
is content-free system telemetry about the serving path. It is the wrong
home for "this approach helped this person".

## 2. What is new

### 2.1 The relationship as an object

A `relationship` entity keyed `{user, counterpart}`, scoped like the user
entity. **`counterpart` is derived from the credential** (OAuth client /
API key → counterpart entity), never from a caller-asserted argument:
otherwise one agent can read another agent's relationship by naming it.

Predicates (registry, with cardinality):

| Predicate                 | Meaning                                      | Lifecycle                                                     |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `commitment`              | "I'll ask tomorrow how the weigh-in went"    | due date = `expectedUntil`; closed by `fulfilled` / `dropped` |
| `open_thread`             | a topic the person wanted to come back to    | closed when returned to                                       |
| `boundary`                | "don't bring up weight before lunch"         | append-only, retract to lift                                  |
| `tone_preference`         | direct / gentle / practical                  | single active                                                 |
| `rupture` / `repair`      | the agent got it wrong; how it was corrected | append-only                                                   |
| `helped` / `did_not_help` | the person's own verdict on an approach      | append-only, grounded in the utterance                        |

None of these requires inferring anything about the person's psyche.
They are what the person said or what the agent committed to.

### 2.2 Consent bound to purpose

Today scope is tenant / user / team. The new axis is _which counterpart,
for which purpose_. A W5 tuple shape:
`(user, shares, <predicate class>, <counterpart | purpose>)`.

Portability defaults, by predicate class in the registry:

| Class                                  | Default                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| boundaries, tone preferences           | portable to every counterpart the user connected         |
| commitments, open threads              | stay with the counterpart that made them                 |
| stated affect, disclosures             | not portable                                             |
| inferred affect                        | not portable, never                                      |
| health data (weight, diet, medication) | not portable; GDPR art. 9 — explicit consent per purpose |

The user can widen or revoke any of these. Revocation reuses W5's
timestamp + `scope_epoch` shift.

### 2.3 Affect as observation, never as trait

| Kind                              | Plane  | Default shelf life       | Served as                                                           |
| --------------------------------- | ------ | ------------------------ | ------------------------------------------------------------------- |
| `stated_affect` ("I'm exhausted") | fact   | 24 h via `expectedUntil` | "said N hours ago"                                                  |
| `inferred_affect` (text or voice) | belief | hours                    | never as current state; only as "a signal at T, source, confidence" |

The default answer to "how is the person now?" is **unknown**, with the
age of the last observation. That is the abstention doctrine applied to
state.

### 2.4 Voice with intonation

Chosen for v1, so it is designed in from the start — as a separable
module that steps 1–4 do not depend on:

- Raw audio stays where it is: evidence plane, media tier, fails closed,
  `brain:read_media`.
- Speech-emotion inference runs as a **remote evidence processor**
  (`EVIDENCE_PARSER_REMOTE` contract) and emits `inferred_affect` beliefs
  with `source: voice`, confidence, and a span pointer into the audio
  fragment. Brain does not host the model.
- Derived affect rows get their own class (e.g. `piiClass: affect`),
  fenced by `brain:read_pii` **and** a purpose-consent tuple. The consumer
  agent never needs `read_media` to read the derived signal.
- Consent to voice affect is its own toggle, off by default, separate
  from consent to recording.

**Gap to close first:** `semantic_belief` carries no `piiClass` and no
row policy (`src/beliefs/beliefs.service.ts`, header). An affect belief
written today would be readable by any user-scoped `brain:read` caller.
The belief plane needs a sensitivity column before affect touches it.

### 2.5 The read surface

One MCP tool, `relationship_context(userId)` — built in, listed only for a
tenant with the `relationship` pack (a pack-declared query tool cannot read
the core `instruction` predicate, by design); the counterpart and purpose
are the credential's circle (trust circles §3.3). Built 2026-10-27, with
the resource `brain://relationship/<userId>`. It returns a brief with citations:

```json
{
  "boundaries": [{ "text": "no weight talk before lunch", "factId": "…" }],
  "tone": { "value": "practical", "factId": "…" },
  "openThreads": [{ "text": "the Friday dinner", "since": "2026-10-22", "factId": "…" }],
  "commitments": [
    { "text": "ask about the weigh-in", "due": "2026-10-24", "overdue": true, "factId": "…" }
  ],
  "state": { "known": false, "lastObserved": "2026-10-22T19:10Z", "kind": "stated" },
  "whatHelped": [
    { "approach": "a concrete plan for the next meal", "verdict": "helped", "factId": "…" }
  ]
}
```

No `suggest_approach`. Brain returns what is known and what the person
said worked; the agent decides how to behave. That keeps brain out of the
business of steering emotions, keeps responsibility where the behaviour
happens, and stays measurable.

Writes go through the normal path: the conversation is ingested, the
extractor (pack-extended with the predicates above) reads commitments,
boundaries and verdicts with memory, as it already does. No new write
tool unless the battery shows the extractor misses them.

## 3. Regulation — part of the design

For the project owner's legal review before anything ships to users:

- **Health data.** The coach treats eating and emotions as health data:
  LGPD art. 11 in Brazil (its consent is already separate and specific),
  UAE PDPL for Dubai, GDPR art. 9 for any EU tenant. Explicit consent,
  purpose limitation; brain must be named as a processor before a
  participant's turns reach it. This is why health predicates are
  non-portable by default.
- **Where the AI Act bites.** Neither first market is in the EU; the
  points below apply to brain as a product offered to EU tenants, and to
  the coach only if it enrols EU residents.
- **EU AI Act, emotion recognition.** Inferring emotion from voice is
  emotion recognition from biometric data. Prohibited in the workplace and
  in education (art. 5(1)(f)) — so a corporate-wellness deployment of the
  coach must run with voice affect **off**. Outside those settings it
  carries transparency obligations (art. 50) and, as we read it, falls
  into the high-risk list (Annex III, biometrics) with the conformity
  burden that implies. Stated affect from text is not biometric.
- Consequence for the plan: voice affect is a module that can be switched
  off per tenant and per deployment context, and steps 1–4 must stand on
  their own without it.

## 4. Objective

The layer learns nothing from implicit signals (session length, return
rate, message count). The only training signal is what the person said
helped or did not help. Every inference is visible to the person, can be
disputed, and can be forgotten. Otherwise the result is perfectly
personalised manipulation.

## 5. Measurement first — `eval:relationship`

A mechanical, judge-free battery in the memory-fitness style. Two
surfaces (coach key, assistant key), scripted multi-session scenarios in
the weight-loss domain, PT + EN, drawn from the coach's real flows
(evening conversation, session agreements, handoffs, off-limits rule). Checks by fact id and scope, no LLM
judge:

| #   | Check                                   | Pass condition                                                                                                                          |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | No stale state                          | a week-old "I'm down" is not served as current; `state.known=false`                                                                     |
| R2  | Boundaries travel                       | a boundary told to the coach appears in the assistant's brief                                                                           |
| R3  | No leaks                                | a disclosure / health fact told to the coach is absent from the assistant's brief and from its search/synthesize results                |
| R4  | Threads and commitments survive         | an overdue commitment surfaces with `overdue: true`                                                                                     |
| R5  | Guess ≠ fact                            | no `inferred_affect` ever appears as stated or as current state                                                                         |
| R6  | Revocation holds                        | after the user revokes sharing, R2's boundary is gone from the assistant at once                                                        |
| R7  | Voice is separable                      | with voice affect off, R1–R6 unchanged and no voice-derived row exists                                                                  |
| R8  | A hypothesis is the person's to confirm | a hypothesis the person rejected is not served as known; one they confirmed is served as stated, with the confirming turn as provenance |
| R9  | What helped, in their words             | what the person said worked and did not work both surface                                                                               |

Baseline: plain brain (user-scoped memory, no relationship layer) on the
same scenarios. Cost estimated before any run, cheap model by default.

### 5.1 Baseline — production, 2026-10-26

`pnpm eval:relationship` against `brain.inite.ai`, eval tenant
`co_eval_relationship`, two credentials (coach: read+write+admin,
assistant: read), strict guardrails, run `relmvpefz7h`, probes asked
after the extraction queue drained (`{"read":0}`). **8/11 scored, 3
skipped** (R4-overdue, R6, R7 need the relationship surface).

| Check            | Result                     | What the memory holds                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 ×2            | pass                       | today's state served; the 12-day-old exhaustion not told as current; work stress → abstain                                                                                                                                                                                                                                                                                                   |
| R2               | pass                       | weight + 9h reach the assistant — because nothing separates surfaces at all                                                                                                                                                                                                                                                                                                                  |
| R3               | **fail** (by construction) | "metformin" reaches the assistant                                                                                                                                                                                                                                                                                                                                                            |
| R4 coach promise | pass                       | `follow_up_planned` on the Coach entity, **due date resolved** to the right day ("depois de amanhã" from c4) — overdue is computable from what is already stored                                                                                                                                                                                                                             |
| R4 specialist    | **fail**                   | the walk is stored as Ana's `goal` ("walk 15 min after lunch 3×/week"); the specialist is gone from it, so "what did Ana agree with her specialist?" abstains. **A commitment loses its counterpart.**                                                                                                                                                                                       |
| R4 open thread   | pass                       | sweets at the office                                                                                                                                                                                                                                                                                                                                                                         |
| R5               | **fail**                   | the coach's tag question _"Acho que você anda ansiosa com o trabalho, né?"_ was extracted as the fact **"Ana is anxious about work"** (`knowledge_fact:x9dbpurk41cjynn4npzp`, provenance = the coach's turn) and served back as "you were anxious about work". **An interlocutor's guess, phrased as a question, became a fact about the person** — the exact failure §2.3 exists to prevent |
| R8               | pass                       | sleep served; "meetings" only negated                                                                                                                                                                                                                                                                                                                                                        |
| R9               | pass                       | fruit helped, the goal list did not                                                                                                                                                                                                                                                                                                                                                          |
| A1               | pass                       | abstains                                                                                                                                                                                                                                                                                                                                                                                     |

What this changes in the plan:

1. **R5 is an extraction defect, not a missing feature.** It is wrong
   today, for every tenant, not only coaching: a speaker's guess about
   the addressee ("I think you…, right?") must land as a belief of the
   speaker, or not at all — never as a fact about the addressee. It
   moves to the front of step 1, measured by R5 and by memory-fitness /
   state-transitions for parity.
2. **Commitments need their counterpart.** Step 1's `commitment`
   predicate carries who it is with (agent or human), so "what did she
   agree with her specialist" has something to land on.
3. **The due date is already there.** `follow_up_planned` resolved the
   relative date correctly; R4-overdue is a read over existing facts.
4. Noise seen in passing: every fact arrives in up to three paraphrases
   (PT and EN, the three self-consistency samples); `synthesize` handles
   it, but a brief built from raw facts would not.

Spend: the run's model cost on prod (33 turns × 3 samples + ~30
syntheses across two passes) is in the cents. Note for re-runs: the
drain endpoint can outlive Cloudflare's 100 s (HTTP 524) — re-ask with
`REL_SKIP_INGEST=1` after `POST /v1/admin/maintenance/extraction`
answers `read: 0`.

## 6. Plan

| Step | Builds                                                                                                                                                                                                                                                    | Exit criterion                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 0    | `eval:relationship` scenarios + harness (`test/eval/relationship/`); baseline numbers                                                                                                                                                                     | baseline scorecard recorded; R3 red by construction (plain brain has no surfaces) |
| 1    | R5 extraction fix first (§5.1); then `relationship` pack: entity, predicates (`commitment` names its counterpart), extractor extension, `relationship_context` + resource; belief confirmation lifecycle                                                  | R4, R5, R8 green                                                                  |
| 2    | Trust circles ([trust-circles-2026-10.md](trust-circles-2026-10.md)): agents as principals, acting circle, `circle:` namespace — the relationship is the circle {person, counterpart}; portability defaults become share acts; scope on `semantic_belief` | R2, R3, R6 green                                                                  |
| 3    | Stated affect with `expectedUntil` defaults; `state.known`                                                                                                                                                                                                | R1 green                                                                          |
| 4    | `helped` / `did_not_help` from explicit verdicts                                                                                                                                                                                                          | verdicts surface in `whatHelped` with factIds                                     |
| 5    | Voice affect: remote processor → `inferred_affect`; `piiClass: affect`; per-tenant/context switch                                                                                                                                                         | R7 green; counsel sign-off on §3                                                  |

Steps 1–4 are shippable without step 5.

## 7. Resolved questions (2026-10-26)

- **Counterpart identity.** Already built: `extractActorId`
  (`src/auth/claim-parsers.ts:108`) takes RFC 8693 `act`, falling back to
  `client_id`; it drives `mcp_agent:<id>` attribution and `agent:<id>`
  policies. Several bots behind one key → RFC 8693 token exchange, one
  `act` each; no custom `counterpart` claim. Static `brain_…` keys have no
  `actorId` → the key itself is the counterpart. The tool takes no
  counterpart argument.
- **Stated-affect shelf life.** Set by the extractor from the text via
  foresight (#687 measured 25/27 temporal states, 0/30 false); 24 h is
  the fallback when the text names no span. Expired state is history,
  not deleted. R1 tells whether the fallback is right.
- **Where the tool lives.** Pack-declared — listed only for tenants that
  installed the `relationship` pack, never added to `core` for everyone
  (schemas are what `tools/list` costs). Plus a resource
  `brain://relationship/<userId>` injected at session start by a hook,
  so the agent has the brief from turn one without having to ask.
- **Speech-emotion model.** Natural (non-acted) speech supports
  arousal/energy far better than valence or discrete emotions, and the
  public sets (RAVDESS, CREMA-D, IEMOCAP) are mostly acted. The processor
  emits arousal/energy only ("sounded tired / agitated / calm") with a
  calibrated confidence; step 5 ships only if, on our data, a stated
  0.8 holds at roughly 80%.
