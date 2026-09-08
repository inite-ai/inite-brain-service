# External Indexer Protocol

How to build a service that reads documents stored in Brain and
contributes structured knowledge — without running inside Brain's
process. An external indexer is a plain HTTP client: it polls for work,
reads stored text, extracts whatever its domain knows how to extract,
and submits candidate facts. Brain re-validates everything server-side
and decides what becomes memory.

A dependency-free reference implementation lives at
[`examples/reference-indexer.ts`](../examples/reference-indexer.ts)
(`pnpm indexer:reference`). For a *real* producer — one that reads a git
repository and derives `code_memory` candidates from it — see
[the code-repository indexer](#the-code-repository-indexer) below
(`pnpm indexer:repo`).

## Prerequisites

1. **A Domain Pack with an external indexer descriptor**, installed for
   the tenant (see [domain-packs.md](domain-packs.md) for authoring):

   ```jsonc
   {
     "id": "my_pack",
     "version": "0.1.0",
     "predicates": [ /* my_pack__* vocabulary */ ],
     "indexer": {
       "mode": "external",
       "relevance": {
         "verticals": ["support"],        // L0: always for these verticals
         "keywords": ["invoice", "SLA"],  // L1: document-head triggers
         "description": "support tickets and SLA discussions" // L2: embedding gate
       }
     }
   }
   ```

   The relevance block decides WHICH documents route to your indexer —
   the same L0/L1/L2 layers dedicated packs use. A pack with no
   relevance triggers only gets documents that explicitly request it
   (`indexers: ["my_pack"]` at ingest).

2. **An API key with the `indexer:write` scope.** This scope can poll,
   claim, read routed documents' content, and stage candidates — it can
   never write facts directly, and never read arbitrary memory.

3. **Operator flags on** (see the enablement runbook in
   [operations.md](operations.md)): `DOCUMENT_INGEST_ENABLED=1` and
   `DOCUMENT_MULTI_INDEXER_ENABLED=1`. Every endpoint below answers
   `503 {"error":"feature_disabled"}` until then.

All endpoints: `Authorization: Bearer <api-key>`, JSON in/out.

## The work-item lifecycle

A work item is one `(document, packId, packVersion)` slot — the same
UNIQUE triple that makes every indexer run idempotent. Ingest creates it
when the router selects your pack; reindexing a pack
(`POST /v1/admin/documents/reindex`) backfills slots for already-stored
documents. A pack version bump opens fresh slots for every document.

```
            ingest / reindex
                  │
                  ▼
   ┌─────────► pending ──────────────── unclaimed for
   │              │                      INDEXER_EXTERNAL_PENDING_TTL_DAYS (7d)
   │        claim │ (or claimless submit)      │
   │              ▼                            ▼
   │           running ───────────────► failed (expired / permanent)
   │              │                            │
   │   lease expired (30m, heartbeat renews)   │ claim (deliberate retry)
   └── release ───┤                            ▼
                  │ submit                  running
                  ▼
              succeeded (terminal — this version's slot is done)
```

Key rules:

- **Claiming is optional.** A single-instance poller may poll → read →
  submit; the submission itself atomically takes the slot (a concurrent
  duplicate gets `409`). Run a fleet of replicas? Claim first so two
  replicas don't extract the same document.
- **The claim lease rides `INDEXER_RUN_STALE_MINUTES` (default 30).**
  Heartbeat well inside it (e.g. every lease/3). An expired claim is
  released back to `pending` automatically — abandoned work is never
  lost, it is re-offered to the next poll.
- **Your work never blocks Brain.** Pending/claimed external slots don't
  defer the document's commit; a late submission re-commits the document
  incrementally. Take hours if you need them (keep heartbeating).
- **Unclaimed work expires** after `INDEXER_EXTERNAL_PENDING_TTL_DAYS`
  (default 7). Poll at least that often.

## The loop

### 1. Poll for work

```
GET /v1/indexer/work?packId=my_pack&limit=50
```

`packId` optional (defaults to every external pack your tenant has
installed), `limit` 1–200 (default 50). Response:

```json
{
  "work": [
    {
      "runId": "indexer_run:vp5vfjjtl0977p0uh9opm",
      "documentId": "source_document:mwuo8lorehim47g4hnu0j",
      "packId": "my_pack",
      "packVersion": "0.1.0",
      "createdAt": "2026-07-15T09:12:44.000Z",
      "docHasContent": true
    }
  ]
}
```

`docHasContent: false` means the document was stored without content
(`storeContent: false`) — there is nothing to fetch; you can only
process it if you have your own copy of the source (see *Ungrounded
submissions*).

### 2. Claim it (optional but recommended for fleets)

```
POST /v1/indexer/work/:runId/claim
{}
```

```json
{
  "runId": "indexer_run:vp5vfjjtl0977p0uh9opm",
  "documentId": "source_document:mwuo8lorehim47g4hnu0j",
  "packId": "my_pack",
  "packVersion": "0.1.0",
  "claimToken": "0b1f9c3e-8f2a-4f4e-9a51-2f4e8d1c7a90",
  "leaseSeconds": 1800
}
```

`409` = someone else holds a live claim, or the slot is already done.
Keep the `claimToken` — it fences every later call. Renew with:

```
POST /v1/indexer/work/:runId/heartbeat
{ "claimToken": "0b1f9c3e-…" }        → { "runId": "…", "leaseSeconds": 1800 }
```

`409` on heartbeat means the lease was lost (expired and re-claimed, or
released) — stop working on this item and re-poll.

### 3. Read the stored content

```
GET /v1/indexer/work/:runId/content
```

```json
{
  "documentId": "source_document:mwuo8lorehim47g4hnu0j",
  "kind": "markdown",
  "vertical": "support",
  "occurredAt": "2026-07-01T10:00:00.000Z",
  "chunkCount": 2,
  "chunks": [
    { "seq": 0, "text": "…verbatim stored text…" },
    { "seq": 1, "text": "…" }
  ]
}
```

This is the document's verbatim stored text (PII-redacted at ingest).
`404` for content-less documents. Served for `pending`/`running` items
only.

### 4. Extract, then submit

Submission goes to the shared external-candidates endpoint. Include
`runId` + `claimToken` to fulfil your claimed slot (omit BOTH for the
claimless flow):

```
POST /v1/documents/:documentId/candidates
{
  "indexerId": "my_pack",
  "runId": "indexer_run:vp5vfjjtl0977p0uh9opm",
  "claimToken": "0b1f9c3e-…",
  "entities": [ { "name": "Acme GmbH", "type": "organization" } ],
  "facts": [
    {
      "entityIndex": 0,
      "predicate": "my_pack__sla_breached",
      "object": "response exceeded the 4h SLA window",
      "confidence": 0.85,
      "clause": "the response exceeded the 4h SLA window agreed in Q2"
    }
  ],
  "relations": [
    { "fromEntityIndex": 0, "toEntityIndex": 1, "kind": "customer_of" }
  ]
}
```

Response:

```json
{
  "runId": "indexer_run:vp5vfjjtl0977p0uh9opm",
  "packId": "my_pack",
  "packVersion": "0.1.0",
  "staged": { "entities": 1, "facts": 1, "relations": 0 },
  "dropped": [
    { "kind": "fact", "index": 1, "reason": "ungrounded_value",
      "detail": "my_pack__sla_breached=\"never call the resolver twice\"" }
  ],
  "ungrounded": false,
  "commit": { "deferred": false, "committed": true, "counts": { "…": 0 } }
}
```

Caps: 200 items per kind per submission; entity names ≤ 256 chars, fact
objects ≤ 2000 chars. Submissions are throttled at 10/min per
credential.

**Episodic candidates (`scenes` / `stateDeltas`, migration 0110).** When
the operator enables `PACK_MEMORY_PROJECTIONS_ENABLED` (default off — the
arrays are rejected 400 otherwise), a pack that declares a manifest
`memoryModel` may additionally stage scene hypotheses and lifecycle
transitions:

```json
{
  "scenes": [
    { "schemaId": "viewing", "label": "Viewing at 12 Elm St",
      "gist": "Client toured the property and weighed an offer.",
      "occurredFrom": "2026-09-01T10:00:00Z", "occurredTo": "2026-09-01T11:00:00Z" }
  ],
  "stateDeltas": [
    { "sceneIndex": 0, "stateModelId": "deal",
      "subject": "the Elm St purchase", "from": "open", "to": "under_offer" }
  ]
}
```

`schemaId` must be one of the pack's own `memoryModel.sceneSchemas` ids
and `stateModelId`/`from`/`to` must match its declared `stateModels`
(declared transitions stay advisory). Each `stateDeltas[i].sceneIndex`
references a scene of the SAME submission. Accepted rows stage as
candidate kinds `scene`/`state_delta` and are projected at commit time
into shadow `memory_episode` rows under `segmenterVersion`
`pack:<packId>+<fp>`; `staged` then carries `scenes`/`stateDeltas`
counts. Scene payloads are default-deny in the candidates audit view —
content opens only under `brain:read_pii`.

**Source-version stamps (`sourceVersion`).** When the operator enables
`PACK_SOURCE_VERSION_STALENESS` (default off — the field is rejected 400
otherwise), a submission may name the revision of the EXTERNAL system of
record it read:

```json
{
  "sourceVersion": {
    "system": "git",
    "ref": "main",
    "version": "9f2c1ab…",
    "readAt": "2026-09-08T05:11:00Z"
  }
}
```

Why it exists: some domains have a system of record that is better than
our copy — exact, versioned, cheap, never wrong about the past. Code has
git; legal has the DMS revision; medical has the study in PACS. For
those, memory should MATERIALIZE what is not derivable (a decision, its
rationale, a gotcha, an invariant) and merely POINT AT what is derivable
(who owns a file, what a flag defaults to, which version a dependency is
pinned to). A derivable claim stored as timeless truth is a promise to
start lying the moment the source moves; bound to a revision it stays
true forever. All four fields are required (a half-stamp is a 400), and
the shape is deliberately not git-shaped — a DMS revision id or an EHR
study id fills the same fields.

The stamp rides candidate provenance into every committed fact's
`source.sourceVersion`, and the same submission runs a DRIFT SWEEP: the
pack's derivable facts whose stamp names an older revision of the same
`system` + `ref` are marked with the existing staleness fields
(`staleAt` / `staleReason = "source_version_drift"`, migration 0072) as
candidates for re-verification, and facts back at the current revision
have that mark cleared. The response then carries a `sourceDrift`
summary. No git ever runs server-side: the current revision is whatever
the indexer — the party holding the working tree — reports.

WHICH facts are derivable is the PACK's declaration, never the engine's
guess. In the manifest `memoryModel`:

```ts
verificationRules: [
  { requires: 'source_version_match',
    appliesTo: ['owns', 'default_value', 'depends_on_version'] },
]
```

`appliesTo` names the pack's own predicate localIds and is mandatory for
this rule. Interpretation predicates (`decided`, `because`, `gotcha`,
`invariant`) are simply omitted: they are statements about the PAST and
do not rot when new commits land. A pack that declares no such rule never
sweeps, and a fact carrying no stamp is untouchable by the sweep by
construction.

### 5. Can't process it? Give it back

```
POST /v1/indexer/work/:runId/fail
{ "claimToken": "0b1f9c3e-…", "error": "shutting down" }
```

Default = **release**: the item returns to `pending` and the next poll
rediscovers it. Add `"permanent": true` for "this indexer cannot process
this document" — the slot is marked `failed`, no longer offered, but a
direct `claim` by `runId` can deliberately retry it later.

## Push notifications (optional)

Polling is the source of truth, but a pack that declares
`indexer.external.callbackUrl` also gets a **push hint**: when ingest
routes a document to your pack, Brain POSTs to your URL:

```json
{
  "event": "work_available",
  "documentId": "source_document:mwuo8lorehim47g4hnu0j",
  "packId": "my_pack",
  "packVersion": "0.1.0",
  "ts": "2026-07-15T09:12:44.000Z"
}
```

Headers: `X-Brain-Event: work_available` and
`X-Brain-Signature: sha256=<hex>` — an HMAC-SHA256 over the raw request
body, keyed by the **webhook secret returned once in the pack-install
response** (`webhookSecret`; upgrades keep the same secret). Verify the
signature before trusting the event; on receipt, just run your normal
poll loop (`GET /v1/indexer/work?packId=my_pack`).

Delivery is best-effort: ~3 attempts with backoff, 5s timeout, and a
5-minute circuit breaker after a failed cycle — never assume every work
item produces a webhook. Respond `2xx` quickly (do the work async);
`4xx` tells Brain to stop retrying that event.

## Grounding rules (why `dropped[]` happens)

Brain never trusts an external span. Every entity `name` and every fact
`object` is re-checked against the stored document text with the same
normalization + whole-token boundary rules the in-process extractor
uses:

- values must appear **verbatim** in the document (case-insensitive,
  whitespace-normalized) — paraphrases are dropped with
  `reason: "ungrounded_value"`;
- an entity that fails grounding drops together with its facts and
  relations (`ungrounded_entity`, then `orphan_reference` for
  dependents);
- `clause` (an optional verbatim citation sentence) is stored for
  provenance display; keep it a real quote.

Drops are reported, never silently swallowed — a nonzero `dropped[]`
with `ungrounded_value` usually means your extractor is summarizing
instead of quoting.

### Ungrounded submissions (`docHasContent: false`)

Documents stored without content cannot be re-grounded. By default the
submission is rejected (`400`, message names the flag). If the operator
enables `DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL=1`, the candidates stage
with `ungrounded: true` and source-trust learning weighs them
accordingly. This is an explicit operator trade, not a default.

## Predicate rules

- Namespaced predicates must be **your own vocabulary**:
  `my_pack__something`. Another pack's namespace is squatting → `400`.
- Unprefixed core predicates are allowed EXCEPT: scope-gated PII
  predicates (e.g. `dob`, `address`) and operator-attested classes
  (e.g. `billing_event`, `human_declared`) → `400`. An external indexer
  stages hypotheses; it cannot seed facts it could never retract.
- `packVersion` in the body is optional; when present it must match the
  installed version (`409` otherwise). Provenance always pins the
  resolved installed version.

## Errors

| Status | Meaning |
|---|---|
| `400` | Shape violation, caps, namespace/predicate fence, grounding gate (content-less doc without the operator flag), `runId` without `claimToken` |
| `401` / `403` | Missing/invalid key; key lacks `indexer:write` |
| `404` | Unknown document; unknown/uninstalled/non-external pack; work item not found (or belongs to another tenant); content of a content-less document |
| `409` | Slot already processed (claimless duplicate); claim lost (token mismatch / lease expired); live claim exists; `packVersion` mismatch |
| `429` | Submission throttle (10/min per credential) |
| `503` | `feature_disabled` — the operator hasn't enabled the pipeline |

## Trust: earned, not granted

Your submissions enter the same merge + commit machinery as in-process
runs — they are *claims*, not truths. A new external indexer starts at
the neutral 0.5 source-trust agreement rate; the nightly refit moves it
up when your facts corroborate other evidence and down when they
contradict it. Consistently quoting the document (clean grounding) and
staying inside your domain is what builds weight.

## Privacy note for operators

`indexer:write` keys can read the **verbatim stored text** of documents
routed to their pack (`/content`) — that text can carry anything the
source carried (post-redaction). Mint per-integration keys, scope packs
narrowly via relevance, and treat external indexers as processors in
your data-protection terms.

## The code-repository indexer

`code_memory` is the only pack in the library that declares
`indexer: { mode: 'external' }`, and for a long time nothing fed it.
`scripts/index-repo.ts` (`pnpm indexer:repo`) is that producer: it walks
a git working tree plus its history and submits `code_memory`
candidates through the protocol above. It is an **operator/CI-invoked
tool** — nothing schedules it, no Nest module imports it, and it makes
no network call at all until `--submit` is passed.

### Dogfood: index this repository

```bash
# 1. See what this repo would contribute. No network, no key needed.
pnpm indexer:repo -- --repo . --dry-run

# 2. Submit for real. The key needs BOTH brain:write (to store the
#    evidence documents) and indexer:write (to stage the candidates);
#    if it is pack-bound it must be bound to code_memory.
BRAIN_API_KEY=<key> pnpm indexer:repo -- \
  --repo . --brain-url https://brain.inite.ai --submit

# 3. Later runs: only the delta since the last recorded HEAD.
BRAIN_API_KEY=<key> pnpm indexer:repo -- \
  --repo . --brain-url https://brain.inite.ai --since auto --submit
```

Operator flags `DOCUMENT_INGEST_ENABLED=1` and
`DOCUMENT_MULTI_INDEXER_ENABLED=1` must be on, as for every external
indexer. Run 2 writes `.brain-indexer-state.json` in the repo root
(override with `--state`); keep it — it is what makes run 3 cheap.

Other flags: `--pack <id>`, `--vertical <name>`, `--modules <a,b>`,
`--max-candidates <n>`, `--max-files <n>`, `--json`.

### How a repository becomes candidates

Brain re-grounds every external span against stored document text, so
the indexer first composes an **evidence document**: one block per
claim carrying the anchor, the value, the *derivation rule* that
produced it, and the artefact quoted verbatim with its file and line
span. That document is ingested (`POST /v1/ingest/document`, routed with
`indexers: ["code_memory"]`), and the candidates are then staged against
it with the claimless flow. The document is the audit trail — every
claim can be re-derived from it without trusting the indexer.

Nothing is guessed. Every fact traces to a concrete artefact:

| Predicate | Evidence |
|---|---|
| `owns` | a CODEOWNERS line; failing that, git-history authorship concentration (dominant author, thresholds stated in the fact) |
| `depends_on_version` | the pnpm lockfile's exact resolution, else the package.json range, verbatim |
| `default_value` | a config-catalogue row, else a `DEFAULT_*` literal — value-shaped tokens only |
| `decided` / `because` | a commit message or an ADR-style `## Decision` / `## Rationale` section that explicitly states one |
| `invariant` / `gotcha` | a comment that explicitly warns ("must", "never", "gotcha", "beware", "⚡"), quoted verbatim |

Semantic summaries of code are deliberately **out of scope**.

### Core + ecosystem modules

The tool is a small language-agnostic core plus a registry of ecosystem
modules (`src/code-memory/repo-indexer/`).

- **Core** (`core/`) always runs and knows no language: git history and
  authorship, CODEOWNERS, commit-message decisions, ADR docs, warning
  comments, the file inventory and caps, dedupe/incremental machinery,
  and the submission client with its client-side fences.
- **Modules** (`modules/`) hold every ecosystem-specific rule. Each
  declares `claims(path)`, an `extract()` returning the same fact shape
  the core emits, and its own `version`, which rides into the derivation
  of everything it produced. Shipping today: `javascript`
  (package.json + pnpm-lock.yaml), `config_catalog`
  (`config-catalog*.data.ts`), `default_constants` (`DEFAULT_*`
  literals).

A repository whose ecosystem has no module still gets everything the
core derives. When two modules claim one path the higher `priority`
wins, ties break on ascending `id` — never registration order. The
registry (`modules/registry.ts`) is an explicit list, not filesystem
discovery.

**Adding an ecosystem** (Python, Go, Rust, a framework) is one new file
under `modules/` exporting an `EcosystemModule`, plus one entry in
`BUILTIN_MODULES`. No core file changes.

### Client-side fences

A candidate that would fail server-side is dropped locally with a
reason, never sent: predicate outside the pack namespace, entity name
over 256 chars, object over 2000, a `default_value` that is prose rather
than a value token (the pack's 0.4.3 rule), a span that is not verbatim
in its evidence document, and `single_active_collision` — for a
predicate the pack declares `single_active` (`owns`, `default_value`,
`depends_on_version`, `decided`) several claims on one anchor would make
the last supersede the rest, so only the strongest is sent.

The single-active set is read from the pack manifest, never restated, so
the fence and the ontology cannot drift. That is how a **domain
modelling error** surfaced: the first dogfood pass dropped 1254
legitimate `invariant` facts across 515 anchors, because `invariant` had
shipped as `single_active` since the pack's first version. A module's
invariants coexist — "every handler validates its body with the shared
zod schema" and "amounts are always emitted in cents" are both true of
one file at once — so supersession there was pure data loss. Pack
**0.6.0** makes `invariant` `append_only`; `decided` deliberately stays
`single_active` (an anchor has exactly one *current* decision, and
`superseded_by` records what replaced the old one).

### Caps

| Cap | Default | Meaning |
|---|---|---|
| `maxFiles` | 5000 | working-tree files opened |
| `maxFileBytes` | 512_000 | larger files skipped whole |
| `maxCommits` | 500 | commits read in an incremental run |
| `ownershipHistoryDepth` | 200 | commits inspected for authorship |
| `maxCandidates` | 500 | facts emitted per run |
| `maxFactsPerDocument` | 120 | facts per evidence document (server allows 200/kind) |
| `maxDocChars` | 100_000 | evidence-document text (server hard cap 512_000) |
| `maxWarningsPerFile` | 5 | warning comments taken from one file |

`.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `vendor`,
`third_party`, `models` and other dot-directories (except `.github`) are
never walked; symlinks are never followed; binaries are detected by a
NUL byte in the first 8KiB and skipped.

## See also

- [Document pipeline](document-pipeline.md) — where work items come from and how candidates become memory.
- [Domain Packs](domain-packs.md) — authoring the pack that registers your indexer.
- [API reference](api.md) — the work API + candidates endpoints in the full surface index.
- [Operations](operations.md#enabling-the-document-pipeline--external-indexers) — the operator enablement runbook.
