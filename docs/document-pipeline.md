# Document pipeline — Source → Indexer → Candidates → Brain

How whole documents become memory. The pipeline splits ingestion into
four layers with deliberately hard boundaries: extraction PROPOSES,
exactly one decision engine DISPOSES. Everything here is dark behind
`DOCUMENT_INGEST_ENABLED` (default off); with the flag off the legacy
mention/fact paths behave byte-identically.

```
Source          normalized document (brain doesn't know what a PDF is)
  → Indexer     composable domain readers (one union pass + opt-in
                dedicated pack runs, gated by a relevance router)
  → Candidates  "this MIGHT be a fact" — staged hypotheses, not memory
  → Brain       merge / dedupe / conflict-resolve → CommitMemory
```

Schema: migrations `0048` (source_document + source_chunk), `0049`
(indexer_run + candidate), `0050` (origin-keyed corroboration). Code:
[`src/documents/`](../src/documents/) + [`src/indexers/`](../src/indexers/).

## Source

Connectors own raw formats (PDF, email, chat exports, git). What crosses
the API is a **normalized document**: text + `kind` + `occurredAt` (the
document's own clock — becomes the facts' `validFrom`) + an `originUri`
pointer back to the container.

- **Identity = content.** `contentHash` (sha256 of the redacted text) is
  UNIQUE — re-sending the same document dedupes at the door, and the hash
  doubles as the fact-level origin identity (`originKey = doc:<hash>`,
  see corroboration below).
- **PII is redacted before hashing**, then the text is chunked to the
  extractor's 16K clamp (paragraph-boundary cuts, small overlap;
  `DOC_CHUNK_TARGET_CHARS`).
- **Storage is optional.** `storeContent: false` keeps only the header +
  hash: extraction still runs from the request body, but the document
  cannot be re-indexed or span-re-validated later — an explicit privacy
  trade. `DELETE /v1/documents/:id/content` purges chunks after the fact
  (header + hash survive so dedupe and provenance pointers keep working);
  `retainUntil` does the same on a schedule via the nightly sweeper. Either
  purge path also stamps `source.provenancePurged: true` on the facts
  committed from that document — the claims stay believed (no retraction),
  but operators can tell them apart from facts whose source text is still
  retrievable.

## Indexer

An indexer is a domain-aware reader. Three execution modes, declared in
the Domain Pack manifest (`indexer` descriptor — see
[Domain Packs § Indexer descriptor](domain-packs.md#indexer-descriptor)):

| Mode | What runs | Marginal cost |
|---|---|---|
| `virtual` (default) | Rides the single `'_general'` union extraction call; its facts are attributed by predicate namespace (`packId__*`). | zero LLM calls |
| `dedicated` | Its OWN extraction run: pack-filtered vocabulary + profile, optional per-pack `model` / `scPasses`. | +1 call per chunk, router-gated |
| `external` | A remote service reads the document and POSTs candidates (below). | zero brain-side calls |

The **relevance router** gates dedicated runs per document, in cost
layers: explicit request / vertical subscription / `alwaysRun` (free) →
keyword triggers over the document head (free) → cosine between the head
and the pack's `relevance.description` (embedder-LRU-cached). A dedicated
pack with no relevance triggers runs only when explicitly requested.
`?mode=union|dedicated` on the pack-eval endpoint measures whether
dedicated mode actually buys a pack anything — opt in on evidence, not
vibes.

Every run lands in the `indexer_run` ledger, UNIQUE on
`(docId, packId, packVersion)` — re-runs skip, upgrades re-open the slot.

## Candidates

An indexer's output is staged in the `candidate` table, one row per
entity / fact / relation, with full provenance (pack, version, execution
mode, model, chunk). Not memory yet. Lifecycle:

```
pending → committed   (drove a graph write; statusReason = resolver outcome)
        | merged      (folded into a sibling's commit; merged_into:<id>)
        | rejected    (orphan reference, low confidence, resolver REJECTED,
                       failed span-grounding)
        | expired     (nightly sweeper: pending older than
                       CANDIDATE_PENDING_TTL_DAYS)
```

Decided rows older than `CANDIDATE_RETENTION_DAYS` are deleted by the
sweeper — their outcome lives on in the committed fact's provenance.
`GET /v1/documents/:id/candidates` is the audit view.

## Brain (CommitMemory)

The commit step takes a document's pending candidates — possibly from
several indexers — and:

1. **Unifies entities** across runs/chunks by `(type, folded name)`; each
   unique entity resolves ONCE through the same `EntityUpsertService` the
   mention path uses.
2. **Merges duplicate facts** by `(entity, predicate, normalized object)`.
   Confidence is the **max**, never noisy-or — indexers reading the same
   document are not independent evidence. All contributors survive in
   `source.indexers[]`; the leader's indexer becomes `source.recorder`
   (per-indexer trust learning rides the existing nightly refit).
3. **Drives `fn::resolve_fact`** — reject / corroborate / supersede /
   compete / insert, trust snapshots, conflict traces. There is no second
   decision engine; document facts and API facts are judged identically.
4. **Records the outcome** back onto every candidate row.

In async mode (`DOCUMENT_MULTI_INDEXER_ENABLED`), each indexer run is an
`index_document` job; every finishing run enqueues a `commit_document`
that DEFERS until all runs for the document are terminal — the last one
commits the full candidate set in a single merge. A pack that fails after
`maxAttempts` is terminal: partial commit is correct, one broken pack
must not hold a document's memory hostage.

### Origin-keyed corroboration (migration 0050)

Corroboration used to key on `sourceKey = vertical:recorder` — WHO
recorded the claim. With several readers per document that fabricates
independence: two indexers over one meeting would "independently
confirm" each other. `fn::origin_key_of` now decides independence by the
**origin document** (`source.originKey`, `doc:<contentHash>`), falling
back to the source key when absent — every pre-0050 fact reproduces
bit-for-bit.

- Same document, any number of readers → refresh, never corroboration.
- Different documents, even through one connector → independent evidence
  (`CORROBORATED`, corroboration count feeds read-time `fact_trust`).

## Re-indexing

The payoff of storing normalized text: `reindex_documents` runs ONE
pack's extraction over the tenant's stored documents — triggered by
`POST /v1/admin/documents/reindex`, or automatically on pack
install/upgrade with `REINDEX_ON_PACK_INSTALL=1`. Budgeted batches
(`REINDEX_MAX_DOCS_PER_RUN`) self-chain with an id cursor; the run ledger
skips whatever the pack version already processed; the extraction cache
eats unchanged text. New candidates merge against existing memory through
the same resolver — originKey keeps a document from corroborating itself.

## External indexers

A remote service (CI job, SaaS integration, an agent) registers as a pack
with `indexer: { mode: 'external' }`, reads the document however it
wants, and stages its reading:

```
POST /v1/documents/:id/candidates        scope: indexer:write
{ "indexerId": "code_memory",
  "entities": [{ "name": "src/resolver.ts", "type": "asset" }],
  "facts": [{ "entityIndex": 0, "predicate": "code_memory__decided",
               "object": "resolve facts through one gateway",
               "confidence": 0.9 }] }
```

Server-side enforcement — the parts an external caller can't be trusted
to do:

- the indexer must be an installed pack declared `mode: 'external'`
  (registered identity, version checked against the install);
- fact predicates must live in the pack's own namespace or core — no
  squatting another pack's vocabulary;
- **spans are re-grounded** against the stored document text with the
  same normalization + word-boundary rules as the in-process extractor:
  fabricated values are dropped and reported, not stored. Documents kept
  without content stage candidates flagged `ungrounded: true` instead —
  source-trust learning compensates;
- the run ledger applies — a duplicate submission for the same pack
  version is a 409;
- `indexer:write` is deliberately narrower than `brain:write`: the key
  stages hypotheses, the Brain decides.

After staging, the commit runs under the same settled-runs rule as the
async queue. Trust for an external indexer is *earned*: it starts at the
neutral 0.5 agreement rate and moves with the nightly source-trust refit.

### Work discovery (pull API)

How does an external indexer learn WHICH documents to read? Ingest
routes documents to installed external packs with the same L0/L1/L2
relevance layers as dedicated packs and pre-creates a `pending` external
`indexer_run` per selection — a work item. The indexer then drives the
loop (scope `indexer:write`, full protocol in `docs/indexer-protocol.md`):

```
GET  /v1/indexer/work?packId=&limit=      list pending work items
POST /v1/indexer/work/:runId/claim        CAS claim + claimToken lease
POST /v1/indexer/work/:runId/heartbeat    renew the lease
GET  /v1/indexer/work/:runId/content      stored chunks to read
POST /v1/indexer/work/:runId/fail         release (default) / permanent fail
POST /v1/documents/:id/candidates         submit (runId+claimToken optional)
```

Claiming is optional — a single-instance poller may poll → read →
submit, the submission's own run CAS is the claim. External work items
NEVER defer a document's commit (a slow poller can't hold memory
hostage); a late submission re-commits incrementally. Abandoned claims
release back to `pending` after `INDEXER_RUN_STALE_MINUTES`; unclaimed
items expire after `INDEXER_EXTERNAL_PENDING_TTL_DAYS`. Reindexing an
external pack (`POST /v1/admin/documents/reindex`) backfills work items
instead of running in-process extraction.

Packs that declare `indexer.external.callbackUrl` additionally get a
**push hint**: ingest fires a `work_available` POST (HMAC-signed with
the per-install secret minted at pack install, returned once in the
install response; header `X-Brain-Signature: sha256=<hex>`) with
retries and a per-URL circuit breaker. Push is a latency optimization
only — polling remains the source of truth
(`INDEXER_WEBHOOK_PUSH_ENABLED` kill switch, default on).

## Flags and knobs

| Env | Default | Meaning |
|---|---|---|
| `DOCUMENT_INGEST_ENABLED` | `0` | Master switch for the whole surface. |
| `DOCUMENT_MULTI_INDEXER_ENABLED` | `0` | Dedicated runs + router + async mode. |
| `REINDEX_ON_PACK_INSTALL` | `0` | Backfill hook on pack install/upgrade. |
| `INGEST_MENTION_VIA_DOCUMENT` | `0` | Route mentions through the pipeline (response shape preserved). |
| `DOC_MAX_CHARS` | `512000` | Document size cap (413 above). |
| `DOC_CHUNK_TARGET_CHARS` | `12000` | Chunker target (hard max 16K). |
| `CANDIDATE_MIN_CONFIDENCE` | `0` | Brain-side prefilter before the resolver. |
| `CANDIDATE_RETENTION_DAYS` | `30` | Sweeper: delete decided candidates after. |
| `CANDIDATE_PENDING_TTL_DAYS` | `7` | Sweeper: expire stuck pending candidates after. |
| `REINDEX_MAX_DOCS_PER_RUN` | `500` | Backfill batch budget per job. |
| `INDEXER_EXTERNAL_PENDING_TTL_DAYS` | `7` | Sweeper: expire unclaimed external work items after. |

## Observability

Prometheus: `brain_documents_total{result}`,
`brain_indexer_runs_total{outcome}`, `brain_candidates_total{kind,decision}`,
`brain_commit_memory_total{outcome}`; async legs ride the standard
`brain_job_*` metrics. Traces: `ingest.document`, `indexer.run.extract`,
`brain.commit` (+ a `brain.commit.merge` artifact with per-document merge
stats). Per-pack stats live on `indexer_run.stats` rows — pack ids are
unbounded, so they are deliberately not metric labels.
