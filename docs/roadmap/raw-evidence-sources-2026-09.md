# Raw-evidence sources — how brain reads what already exists (2026-09-16)

Question asked: *brain should be able to index raw evidence that is
already out there — files, APIs of information systems — locally for
personal use, on a server, or in the cloud via plugins. We seem to have
nothing on this. How do we build it state-of-the-art, built into what
exists (Domain Packs, MCP), with no duplication and no reinvention?*

Answer in one line: **everything downstream of "here are the bytes" is
built (evidence plane, document pipeline, provenance, drift, GDPR), and
the *pattern* for a source is built too — `code_memory` is a pack that
declares an external indexer whose connector runs where the code lives.
What is missing is the generalisation of that one instance: a `sources`
section in the pack manifest, a per-tenant connection row, a catalogue
of external items, and a sync engine on the jobs queue. The plugin half
is MCP resources; the personal half is the repo-indexer runner grown
into an agent. Two new tables, zero new registries.**

Method: read the shipped write-side surface (`src/documents/`,
`src/evidence/`, `src/indexers/`, `src/code-memory/repo-indexer/`,
`src/ai/domain-packs/`, `src/mcp/`, `src/jobs/`, `src/policy/`,
`src/auth/scope-*`, `clients/`, `plugins/`), mapped every proposed piece
onto an existing seam, and read how the 2026 field (Onyx, Glean, ChatGPT
connectors, Supermemory, Nango, Khoj, the 2026-07-28 MCP revision,
`.mcpb`) solves the same problem. Every claim about our code carries a
`file:line`.

---

## 1. What exists — the doors, and the one source that already works

Three doors, all push — the caller has already fetched, converted and
decided:

| Door | Shape of input | Where |
|---|---|---|
| `POST /v1/ingest/mention` | conversation turns → episode substrate → extraction | `src/ingest/` |
| `POST /v1/ingest/document` | normalised text + `kind` / `occurredAt` / `originUri` / `contextRef` | `src/documents/dto/ingest-document.dto.ts:41-44` ("Connectors with more split into multiple documents"); document-pipeline.md § Source: "Connectors own raw formats" |
| `POST /v1/ingest/evidence-blob` | bytes → content-addressed blob (fs / s3) → platform processors (pdf text, image metadata, OCR) | `src/evidence/evidence.module.ts:30-45`, `src/evidence/storage/storage-adapter.ts` |

And one complete source, end to end — **`code_memory`**:

- the pack declares `indexer.mode: 'external'` ("the pack IS a
  registration for a remote indexer… The builtin `code_memory` pack is the
  reference external indexer — its capture pipeline runs where the code
  lives", `docs/domain-packs.md:281-284`);
- the connector is `src/code-memory/repo-indexer/run.ts` — walks git,
  derives structural facts **without an LLM**, composes deterministic
  evidence documents, submits candidates through the external-indexer
  protocol, keeps a `RunState` file for incremental `--since`
  (`run.ts:1-18, 36-43`);
- every submission carries a `SourceVersionStamp` — `{system, ref,
  version, readAt}`, "DELIBERATELY NOT GIT-SHAPED… A DMS revision id or an
  EHR study id fits the same four fields" (`src/common/source-version.ts`);
- the pack's `verificationRules: requires 'source_version_match'` makes
  the drift sweep mark facts from an older revision stale
  (`code-memory.pack.ts:357`, `source-drift-staleness.service.ts:1-40`).

Everything a source layer needs to *reuse* is present and hardened:

- **Identity = content.** `source_document.contentHash` UNIQUE
  (`0048:55`), `evidence_asset.byteHash` UNIQUE (`0109:132`).
- **The source's clock is the fact's clock** — `occurredAt` → `validFrom`.
- **Extraction proposes, one engine disposes** — candidates →
  `fn::resolve_fact`; the relevance router (L0 vertical / L1 keywords /
  L2 cosine) decides which packs read a document.
- **Jobs framework** — multi-pod, leases, fencing, `dedupKey`,
  `job_run.result/progress/payload FLEXIBLE`, admin cockpit + SSE
  (`src/jobs/`, `0025`); the canonical "mold" is *onModuleInit register +
  cron-time enqueue + queue handler* (`registry-mirror.service.ts:20-30`),
  and `registry-mirror-sync.ts` is already a pull-sync with pure merge
  rules.
- **Pack machinery** — signed/checksummed manifest, install consent
  *per section* with a checksum so an upgrade re-asks only when the
  section changed (`mcp-consent.ts:1-20`), per-install `installId` +
  `webhookSecret` (`0065`), HMAC-signed outbound calls, the egress guard
  (`src/common/egress-guard.ts`), the global registry with publisher
  profiles, mirroring and the marketplace (paid packs).
- **MCP** — brain serves its tool surface in `core`/`full`/`chatgpt` profiles (`tool-profiles.ts`),
  `find_tool`/`run_tool` meta-tools, `brain://entity/…` resources; and a
  real MCP **client** already exists in `clients/brain-mcp/src/index.ts:103`
  (`new Client(...)`, `resources/list` / `templates/list` / `read`
  passthrough).
- **Scope tags (G6)** — `scope: array<string>` on every scoped table
  (`0093`, `0109:109`, `0128`), `org:`/`team:` namespaces reserved,
  `visibleUnderScope` OR-of-ANDs evaluator behind `SCOPE_TAGS_ENABLED`
  (`src/auth/scope-visibility.ts`), and the G6 design already names
  Zanzibar tuples for membership and consistency tokens
  (`sota-gap-build-2026-08.md:213-229`).
- **ABAC** matches `source.meta.<key>` and `recorder` ("Recorder /
  connector that wrote the fact", `policy.types.ts:59`).
- **Source reputation** keyed `vertical:recorder`, types
  `website | document | api | …` — a connector that names itself as
  recorder earns trust for free (`sources.schema.ts:11-18`,
  indexer-protocol.md § Trust).
- **Tool observations (0111)** — an external call's response can be
  ingested as a document with a verified provenance hop
  (`tool-observation-meta.ts`).

## 2. What does not exist — verified gaps

| # | Gap | Evidence |
|---|---|---|
| G1 | **Nothing pulls.** No code enumerates a folder, bucket, mailbox, Drive, Notion space or HTTP API. `originUri` is "a pointer the brain never fetches" | `0109_*.surql:99-100` |
| G2 | **No catalogue of external items.** `source_document` is keyed by *content*, `evidence_asset` by *bytes*; nothing is keyed by *location* ("the thing at X, revision Y, last seen Z"). Without it: no diff, no rename/move, no "changed since", no deletion detection | `0048:32-56`, `0109:74-135` — no `externalId` / `revision` / `lastSeenAt` |
| G3 ⚡ | **The two half-pipelines do not meet.** Evidence processing turns a PDF into text in `derived_representation` (embedded for the fragment lane) but never into a `source_document` → no facts from an uploaded PDF | `processing-run.service.ts` writes representations only; `grep assetId src/documents/*.ts` → 0 |
| G4 | **No outbound OAuth.** Auth verifies *inbound* tokens (JWKS, introspection, RFC 9728); brain cannot be an OAuth client to Google / Microsoft / Slack / Notion. Reversible secrets at rest exist only as `domain_pack.webhookSecret` (plaintext, tenant DB) | `src/auth/`, `0065:11` |
| G5 | **The server side is never an MCP client.** The SDK `Client` lives only in `clients/brain-mcp`; `src/mcp/*` serves | `grep -rl @modelcontextprotocol/sdk src` → `src/mcp/*` |
| G6 | **No local agent beyond git.** The plugin captures *conversation* (`brain-hook.mjs:1-16`); the repo indexer is the only thing that reads a user's disk | — |
| G7 | **Deletions at the source are invisible.** Purge and `retainUntil` exist; nothing observes "the file is gone" | — |
| G8 | **External ACLs have no writer.** G6 reserved `org:`/`team:` tags and designed the tuples; no code emits them ("no writer emits it in step 1", `scope-tags.ts:24-26`) | — |
| G9 | **The pack manifest cannot declare a source.** It declares `indexer` (how to *read* documents), `mcpTools`, `seedDocuments`, `memoryModel` — nothing says *where documents come from* | `manifest.ts:56-114` |

## 3. What state-of-the-art looks like in 2026

| System | Take | Refuse |
|---|---|---|
| **Onyx** — connector–credential pair with own checkpoint, run ledger, `prune_freq`; doc-level + group-level permission-sync attempts; oversized ACLs are sync errors | The *unit* and its lifecycle (active / paused / deleting); prune as a separate cadence | Server-only |
| **Glean** — identity crawl before content crawl; ACLs mirrored per document; enforced at query time | Permission is crawled data | Crawl everything up front |
| **ChatGPT connectors** — *linked* (query live) vs *synced* (indexed ahead; hours–days for an org) | Two modes as a product decision | — |
| **Supermemory** — memory API shipping Drive/Gmail (webhooks, Pub/Sub), Notion, OneDrive (4h), GitHub, crawler | Our category now has sources; table stakes | Copy everything by default |
| **Nango** (OSS) — managed OAuth + refresh + encrypted credentials + incremental syncs, 1000+ APIs | Keep the credential seam pluggable so Nango can sit behind it for the long tail | Renting the core |
| **MCP 2026-07-28** — `resources/list` (paginated, `ttlMs`), `resources/templates/list`, `resources/read` (text / base64 `blob`), `annotations.lastModified`; changes via `subscriptions/listen` (`resourceSubscriptions`, `resourcesListChanged`); `resources/subscribe` and the GET stream are gone; no server-side subscription state across reconnects | **The plugin interface.** Any MCP server exposing resources is a connector we did not write; stateless + polling fits the jobs queue | Assuming every server implements resources well — treat `listChanged`/`subscribe` as optional |
| **`.mcpb`** desktop extensions | One-click delivery of a local process to a non-developer | — |
| **Khoj** — desktop app syncing chosen folders; Obsidian/Emacs clients | The personal shape | Cloud sunset 2026-04; no provenance |
| **Parsers** (ParseBench, 14 methods) — Reducto leads tables/charts at $0.015/page; LlamaParse agentic $0.056; Mistral OCR $0.004; Docling OSS | A pluggable adapter with a cost dial — the `ProcessorAdapter` seam already is that | One parser |

## 4. Doctrine

1. **A source is a pack.** The manifest gains a `sources` section next to
   `indexer` / `mcpTools` / `seedDocuments` / `memoryModel`: declarative
   data inside the signed manifest, its own consent checksum, distributed
   through the registry, sellable through the marketplace. `code_memory`
   is the first source pack, retrofitted; nothing about it changes.
2. **Shape decides the door.** Conversation-shaped items (Slack,
   Telegram, mail threads) enter through `ingest/mention` → episodes;
   document-shaped through `ingest/document`; binary through
   `evidence-blob`; derivable structure through candidates. A connector
   never invents a fifth path.
3. **Catalogue → evidence → facts, hard boundaries.** The catalogue
   knows *where* and *which revision*; the evidence plane holds bytes and
   derived text; the pipeline proposes facts. Mirrors "extraction
   PROPOSES, one engine DISPOSES".
4. **One connector runtime, two hosts.** The same connector module runs
   in the server (mounted volume, S3, cloud APIs, remote MCP) and in the
   local agent (folders, local MCP over stdio). The host owns
   credentials and raw bytes; a personal agent may keep bytes local and
   send redacted text. Natives are platform code (the anti-DSL doctrine:
   "a pack can only declare needs, never supply processors",
   `evidence.module.ts:46-47`); **MCP is the only third-party seam.**
5. **Manifest always, content by policy, extraction by budget.** Seeing
   an item is free and always recorded; fetching is per-connection
   policy; LLM extraction is gated by the relevance router and a budget.
   A retrieval hit on a manifest-only item schedules its deepening.
6. **Every item carries a `SourceVersionStamp`; drift and deletion are
   bitemporal events.** The existing sweep marks; a gone item closes
   `validUntil` (policy `close` | `retract` | `keep`).
7. **Personal is user-fenced by construction; org is G6.** A connection
   owned by a user writes `scope: ['user:<id>']` — done. An org
   connection is the membership *source* for G6 steps 3–5; it does not
   get a parallel principal model.
8. **Default-off, measured before default-on** (project law).

## 5. Reuse map — every proposed piece against its existing seam

| Proposed | Existing seam | What is actually new |
|---|---|---|
| Source plugin / distribution / consent / monetisation | Domain Pack manifest + registry + marketplace + per-section consent checksum (`mcp-consent.ts`) | `sources` section in `DomainPackManifest`; `sourcesChecksum()` + `acceptSources` install flag (copy of the mcpTools pattern) |
| Source vocabulary (`located_in`, `authored_by`, `modified_at`, `sent_by`, …) | Pack predicates + `memoryModel.verificationRules` (`source_version_match`) + media contracts | First-party source packs: `file_memory`, `mail_memory`, `web_memory`; `code_memory` already is one |
| Connection (CC-pair) | `source_registry` (identity + trust, `vertical:recorder`), `domain_pack` install row (`installId`, `webhookSecret`) | **`source_connection`** table (per install, per configured source) — creates its `source_registry` row on connect, `recorder = connection:<id>` |
| Sync-run ledger | `job_run` (`result/progress` FLEXIBLE, dedupKey, leases, cockpit, SSE) | nothing — `jobType: 'source_sync'` with counters in `result` |
| Scheduling | jobs mold: `onModuleInit register` + `@Cron` enqueue + handler (`registry-mirror.service.ts`) | one service in the mold |
| Catalogue of external items | — (see § 5.2 for why `evidence_asset` cannot carry it) | **`source_item`** table |
| Item → document | `DocumentIngestService.ingestDocument()` called in-process (as `pack-seed-ingest.service.ts:98` does) | nothing |
| Item → bytes | `EvidenceUploadService` → broker → processors | nothing |
| Bytes → facts | `ingest_async` job + `INTERNAL_DOCUMENT_META_KEYS` provenance channel | **G3 bridge**: a `text` representation of a `document` asset enqueues `ingest_document` with `internalMeta.evidenceAssetId` |
| Manifest facts without an LLM | repo-indexer's compose-evidence-documents → submit-candidates path (`bundle.ts`, indexer protocol § 4) | nothing — server-side natives call the candidate service directly |
| Drift on any source | `SourceVersionStamp` + drift sweep | nothing — every connector fills `system/ref/version` |
| Deletion | resolver's `validUntil` close (`conflict-resolver.ts:15`), cascade retract (0069), `availability: 'gone'` | `deletePolicy` on the connection + a "close by absence" call into the resolver |
| Routing to packs | relevance router L0 verticals — the connection's `contextRef.vertical` subscribes it to packs | nothing |
| Chat sources | `ingest/mention` + episode substrate | nothing — Slack/Telegram connectors emit turns |
| Publisher-operated source | pack `indexer.external` + `callbackUrl` + HMAC + egress guard; pack `mcpTools.external` proxy | a publisher's *MCP server URL* in `sources`, bearer = per-install secret; brain harvests it (§ 5.4) |
| MCP client | `clients/brain-mcp/src/index.ts:103` | lift the client into a shared module usable server-side (`src/sources/mcp-client/`) and agent-side |
| Local agent | `scripts/index-repo.ts` + `repo-indexer/{run,brain-client,repo-source}.ts` + `@inite/brain` SDK + plugin hooks + multi-target installer | `clients/brain-agent` = the runner generalised; git becomes one connector of it; `SessionStart` hook may run `brain-agent sync` |
| Credentials, W0–W3 | `domain_pack.webhookSecret` posture (tenant-DB row) | nothing — publisher MCP servers use the install secret; the agent keeps its own |
| Credentials, W4 | s3 adapter's `encryptionContext` / `kmsKeyRef` idea | encrypted `credential` column on `source_connection` + an outbound OAuth 2.1 client; `CredentialProvider` seam (own \| Nango) |
| External ACLs | G6 steps 3–5: `team:`/`org:` tags, `visibleUnderScope`, Zanzibar tuples, consistency tokens | the connector's `principals()` as the tuple *source*; item ACL → `scope` tags on rows |
| Lazy read of un-fetched items | `EvidenceStorageAdapter` registry resolves by scheme; read gateway serves only `hot` (`evidence-read.service.ts:298-299`) | a read-through: `external` → fetch via connection → `put` → `hot` |
| Catalogue visible to harnesses | `brain://entity/…` resources + `brain-mcp` passthrough | `brain://source/{connection}/{path}` resource template over `source_item`, `read` through the gateway |
| Admin surface | `/v1/admin/sources` (`admin-sources.controller.ts`), packs admin, jobs cockpit | `/v1/admin/sources/connections` CRUD + `sync-now` |
| MCP tools | `full` profile, `find_tool`/`run_tool`, `how_to_connect` | `list_source_connections`, `sync_source` (full profile only); `how_to_connect` learns to describe sources |
| Linked (non-indexed) mode | pack `mcpTools.external` + tool-observation hop (0111) — an external answer is already citable evidence | a retrieval lane that calls a source's search tool at query time (W7) |
| Parsers | `ProcessorAdapter` first-match registry; OCR's own opt-in switch as precedent | `docling` + remote-parser adapters |
| Flags | `config-catalog.data.ts` with defaultValue derived from the reader | entries per wave |

### 5.1 The manifest section

```jsonc
"sources": [
  {
    "id": "drive",                       // snake_case, unique in the pack
    "kind": "mcp",                       // 'mcp' | 'native' | 'external'
    "transport": "http",                 // mcp: 'http' (server host) | 'stdio' (agent host)
    "url": "https://mcp.publisher.example/drive",   // http: egress-guarded at install AND per call
    "auth": "oauth",                     // 'oauth' | 'install_secret' | 'none'
    "shape": "document",                 // 'document' | 'conversation' | 'binary' | 'structure'
    "defaults": { "contentPolicy": "text", "deletePolicy": "close", "schedule": "1h" }
  },
  { "id": "vault", "kind": "native", "connector": "fs", "shape": "document" },
  { "id": "ci",    "kind": "external" } // the publisher pushes (today's external indexer)
]
```

`kind: 'native'` may only name a connector the platform ships (the same
rule as `processors`: declaring one with no adapter arms a dispatch that
always denies). `kind: 'external'` is exactly `indexer.mode: 'external'`
seen from the source side — `code_memory` retrofits to it with one
line. Consent: `acceptSources` at install, checksum over the section,
re-asked only when it changes. `code_memory`'s `indexer.external`
descriptor stays as is; the `sources` entry is additive.

### 5.2 Tables (`0150_source_plane.surql`)
### 5.2 Tables (`0149_source_plane.surql`)

**`source_connection`** — Onyx's CC-pair, homed on an install:
`packId`, `sourceId` (manifest entry), `ownerUserId` (null = org),
`host` (`server` \| `agent:<id>`), `config` (FLEXIBLE, no secrets),
`credential` (option<string>, W4 encrypts), `mode` (`synced` \| `linked`),
`schedule`, `contentPolicy`, `extractionBudget`, `deletePolicy`,
`status` (`active` \| `paused` \| `deleting`), `checkpoint` (FLEXIBLE),
`sourceKey` (its `source_registry` row), `lastSyncAt`, `scope`.

**`source_item`** — the catalogue, one row per external item per
connection: `connectionId`, `externalId`, `originUri`, `path`, `title`,
`mediaType`, `size`, `revision`, `modifiedAt`, `byteHash?`,
`contentHash?`, `assetId?`, `documentId?`, `episodeId?`, `acl` (FLEXIBLE
snapshot), `state` (`seen` \| `fetched` \| `indexed` \| `gone`),
`firstSeenAt`, `lastSeenAt`, `goneAt`, `userId`, `scope`. UNIQUE
`(connectionId, externalId)`.

Why not `evidence_asset` with `availability: 'external'`: its identity is
`byteHash UNIQUE NOT NULL` — an item we have only *seen* has no bytes, and
two locations with identical bytes are one asset but two catalogue
entries with independent lifecycles (one may be deleted). Identity by
*location* is a different axis from identity by *content*; the catalogue
links to the asset/document it produced, never replaces them.

No `sync_run` (it is `job_run`), no `source_credential` (a column), no
`external_principal` (G6's tuple table when G6 step 3 lands).

### 5.3 Connector interface (`src/sources/connectors/`, registered like `EVIDENCE_PROCESSOR_ADAPTERS`)

```ts
interface Connector {
  readonly kind: string;                                     // 'fs' | 's3' | 'url' | 'mcp' | 'gdrive' | …
  enumerate(ctx: ConnectorCtx, checkpoint: unknown | null):
    AsyncIterable<ItemDelta /* upsert | gone */ | Checkpoint>;   // cheap, no bytes
  fetch(ctx: ConnectorCtx, item: ItemRef): Promise<FetchedItem>; // bytes | text | turns
  watch?(ctx: ConnectorCtx, hint: (h: ChangeHint) => void): Promise<Unwatch>; // engine still polls
  principals?(ctx: ConnectorCtx): AsyncIterable<PrincipalDelta>;  // org connections → G6 tuples
  search?(ctx: ConnectorCtx, q: string, k: number): Promise<LinkedHit[]>; // linked mode (W7)
}
```

`ConnectorCtx` carries the resolved credential, a rate limiter, the
egress-guarded `fetch`, and the host. `FetchedItem.shape` decides the
door (doctrine 2). Checkpoints are opaque per connector — Drive
`changes.startPageToken`, Gmail `historyId`, Graph delta link, Slack
cursor, Notion `last_edited_time` + cursor, IMAP `MODSEQ`, git `since`,
fs `(mtime, size, hash)`, MCP `(uri → lastModified | contentHash)`.

### 5.4 The engine (`SourceSyncService`, jobs mold; `jobType: 'source_sync' | 'source_fetch' | 'source_prune'`)

1. `enumerate` from `checkpoint`; upsert deltas into `source_item`.
2. Diff: new / changed (`revision` or `byteHash`) / unchanged / gone.
3. Fetch by policy → the door for the item's shape, with
   `originUri`, `occurredAt = modifiedAt`, `recorder = connection:<id>`,
   `contextRef.vertical` from the connection, `sourceVersion = {system:
   kind, ref: externalId, version: revision}`, `scope` from the owner.
4. Drift: the existing sweep, now fed by every connector.
5. Gone: `deletePolicy` — `close` (default) stamps `validUntil = goneAt`
   through the resolver's close path and `availability = 'gone'`;
   `retract` runs cascade-retract; `keep` marks only.
6. Idempotent on `(connectionId, externalId, revision)`: a re-run over
   an unchanged source is 0 writes, 0 LLM calls (the repo-indexer's
   contract, engine-wide). Counters land in `job_run.result`.

**MCP harvester** (`kind: 'mcp'`): `resources/templates/list` +
paginated `resources/list`; diff on `annotations.lastModified`, else on
content hash after `read`; `watch` = `subscriptions/listen` with
`resourcesListChanged: true` + `resourceSubscriptions` for hot URIs,
re-sent on every reconnect. `text` → document door, `blob` → evidence
door, `https://` fetched directly through the egress guard. Conformance
matrix: the reference filesystem, git, GitHub, Google Drive and Slack
servers.

### 5.5 The local agent (`clients/brain-agent`, `@inite/brain-agent`)

The repo-indexer runner generalised: `RunState` → per-connection
checkpoint file, `BrainClient` → `@inite/brain`, `RepoSource` → one
connector among `fs` (fsevents/inotify, debounce, hash diff), `git`,
`mcp` (stdio). PII redaction runs *before* anything leaves the machine;
pushes go through the three existing doors; brain sees a connection with
`host: agent:<id>` and never holds the user's local credentials.
Delivery: `.mcpb` for Claude Desktop, the Claude Code plugin (a
`brain-sync` skill; `SessionStart` may run `brain-agent sync --since`,
so personal use needs no daemon), the multi-target installer, a plain
CLI. The fully-local brain (`docker compose` on a laptop) needs no agent:
the server-host `fs` connector over a mounted volume.

### 5.6 The catalogue as an MCP surface

Symmetry: what brain harvests as resources it re-exposes as
`brain://source/{connection}/{path}` resource templates (paginated over
`source_item`, `read` through the evidence read gateway with its PII and
`rawEvidence` gates). A harness browses the synced corpus with the same
verbs brain used to collect it; `brain-mcp` passes it through unchanged.

### 5.7 Permissions

Personal connections write `scope: ['user:<owner>']` on asset, document
and every derived fact — the 0055/0093 fence does the rest, zero new
code. Org connections are **G6 steps 3–5 built with a real membership
source**: `principals()` fills the tuple table G6 designed, item `acl`
snapshots become `team:<connection>:<group>` tags on rows,
`visibleUnderScope` evaluates the caller's expanded tag set, consistency
tokens on membership change (the new-enemy problem G6 already names).
Oversized ACLs are sync errors, never truncated to public.

### 5.8 Scenario walk-through — "does the plan cover MY source?"

Checked against the code, not the diagram. Three facts constrain the
answers: the egress guard denies loopback / private / link-local
targets (`src/common/egress-guard.ts:9,60`); the only text processors
are PDF and `text/*` + JSON (`document-text.adapter.ts:103`,
`upload-media-types.ts:36` — **no docx / xlsx / pptx / html / eml**);
and "NO GIT LIVES HERE. The server never resolves a ref, never shells
out, never opens a repository" (`source-drift-staleness.service.ts:15-20`).

| Scenario | Shape → door | Host | Connector | Wave | What the plan was missing (now added) |
|---|---|---|---|---|---|
| **My own CRM** (custom REST / DB) | *records* → `structure` → candidates via the external-indexer path, ungrounded flow (`docHasContent: false`, indexer-protocol § Ungrounded) or the record JSON stored as the grounding doc | server (`db`, MCP over HTTP) or agent (`db` with the DSN kept local) | (a) an MCP server in front of it (resources = records) — W2; (b) **`db` native** (Postgres / MySQL / SQLite / SurrealDB read-only: tables/views + `idColumn` + `updatedAtColumn` cursor) — new; (c) the CRM pushes itself (`kind: 'external'`, today's `ingest/fact` + candidates) | W2 / W4 | A **canonical record envelope** `{entityType, externalId, name, attributes, relations, updatedAt}` and the mapping rule: attribute key = a pack predicate `localId` ⇒ deterministic candidate, no LLM; unknown attributes ⇒ LLM extraction over the record text under the pack profile, or dropped by config. Per-tenant field→predicate mapping = the existing predicate **alias registry** (0147), not a new DSL. A `crm_memory` first-party pack. |
| **SaaS CRM** (HubSpot, Salesforce, Pipedrive) | records, as above | server | their MCP servers (W2) or Nango-backed native (W4) | W2 / W4 | same envelope |
| **A wiki** — Confluence / Notion | documents → `ingest/document` | server | native (OAuth) | W4 | Confluence was not listed — added |
| **A wiki** — self-hosted (MediaWiki, BookStack, Outline, DokuWiki, Wiki.js) | documents | server (intranet) or agent | `url` (sitemap / API with auth header) — W1; its MCP server — W2 | W1 / W2 | **Per-connection `egress.allowPrivate`** (brain:admin only, flagged, audited) so an intranet host is reachable from the server host; the agent host has no such fence — it *is* on the LAN |
| **A wiki** — git-backed (GitHub/GitLab wiki, docs-as-code) | documents (+ structure if code) | agent | `git` | W3 | — |
| **Codebase, brain deployed locally** | structure → `code_memory` candidates **and** documents (`README`, `docs/*.md`, ADRs) → `ingest/document` | agent on the same machine (today: `pnpm indexer:repo`), or server-host `fs` over a mounted volume for the docs half | `git` + `fs` | today / W3 | The git connector must emit the repo's docs **as documents** — `decisionsFromDocs` (`repo-indexer/core/decisions.ts:162`) reads them only for decisions today. One repo → two shapes. |
| **Codebase, remote** (GitHub / GitLab / Gitea / Bitbucket) | issues, PRs, wiki, READMEs, files → documents; code structure → candidates | server for the API half; **agent for the git half** (a CI job — `brain-agent sync` as a GitHub Action / GitLab job — or a sidecar next to the repos) | GitHub / GitLab **API** connectors (no shell-out, honours the no-git doctrine) + `git` on the agent | W4 + W3 | Explicit host rule: git never runs in the brain process |
| **Docs in local folders** (incl. Obsidian, Downloads) | documents / binary | agent | `fs` (fsevents/inotify) | W3 | **Office text adapters** (`docx` / `xlsx` / `pptx` via mammoth/officeparser, `html` via html-to-text, `eml` via mailparser) + the `document` upload allowlist widened — moved to **W1**; docling / remote parsers remain the quality tier in W6 |
| **Docs on a network drive** (SMB / NFS) | documents / binary | server (mount the share as a volume) or agent on a machine that has the mount | `fs` in **polling mode** (no fsevents on mounts: mtime + size first, hash only on change) | W1 / W3 | Polling mode + a bounded first walk (large trees) — added to `fs` |
| **Docs on WebDAV** (Nextcloud, ownCloud, Synology, SharePoint-WebDAV) | documents / binary | server | **`webdav` native** (PROPFIND + ETag → incremental without a cursor; basic/bearer credential) | W1 | not listed — added; needs the `credential` column from W0 (plaintext posture until W4 encrypts) |
| **Cloud drives** (Google Drive, OneDrive/SharePoint via Graph delta, Dropbox) | documents / binary | server | native (OAuth) | W4 | OneDrive/SharePoint and Dropbox were not listed — added |
| **Buckets** (S3, MinIO, R2, B2, GCS-interop) | documents / binary | server | `s3` (list + ETag) | W1 | — |
| **Mail** (Gmail; generic IMAP) | threads → *conversation* → `ingest/mention` (episodes), attachments → binary | server | Gmail (history) — W4; **IMAP** (CONDSTORE/QRESYNC) — added | W4 | IMAP was not listed |
| **Chat** (Slack; Telegram bot; WhatsApp export) | conversation → `ingest/mention` | server (bot) or agent (exports) | Slack — W4; **Telegram bot** — added; exports via `fs` | W3 / W4 | — |
| **Tickets / PM** (Jira, Linear, GitHub issues) | records + documents | server | their MCP servers (W2) or API natives (W4) | W2 / W4 | envelope covers them |
| **Web pages / RSS** | documents | server | `url` | W1 | — |
| **Screen / audio capture** (Rewind-class) | audio/video modalities exist in the taxonomy; no ASR adapter | — | — | out of scope | stated, not promised |

Two rules fall out of the table and are now doctrine:

- **Records are a shape, not a document.** A CRM row is entities + facts
  with a revision; it enters as candidates with a `SourceVersionStamp`,
  never as prose to be re-extracted. LLM extraction is the fallback for
  attributes the pack does not name, not the default.
- **Git is agent-host.** The brain process never opens a repository. The
  "agent" is a role, not a laptop: CI jobs and sidecars are agents.

## 6. Waves — each a PR, each behind its own flag

| Wave | Delivers | Flag | Closes |
|---|---|---|---|
| **W0 Source plane** | manifest `sources` section + `sourcesChecksum` + `acceptSources`; `0150` (`source_connection`, `source_item`); `Connector` registry; `SourceSyncService` on the jobs mold; the **record envelope** (`shape: 'structure'` → candidates, ungrounded flow); `/v1/admin/sources/connections`; `code_memory` retrofit (`kind: 'external'`); the **G3 bridge** on its own switch | `SOURCE_PLANE_ENABLED`, `EVIDENCE_DOCUMENT_BRIDGE` | G1 G2 G3 G7 G9 |
| **W1 First natives + first source pack** | `fs` (server path, ignore rules, **polling mode** for mounts, bounded first walk), `s3` (list + ETag), `url` (sitemap / page, egress-guarded, robots-aware, auth header, **per-connection `egress.allowPrivate`** for intranet hosts), **`webdav`** (PROPFIND + ETag); **office text adapters** (docx / xlsx / pptx / html / eml) + widened `document` allowlist; `file_memory` pack (vocabulary + `source_version_match` rules + media contracts); full / incremental / prune; drift from non-git stamps proven | `SOURCE_KIND_FS` / `_S3` / `_URL` / `_WEBDAV`, `EVIDENCE_OFFICE_TEXT` | G1 |
| **W2 MCP harvester** | shared MCP client module; `kind: 'mcp'` over HTTP (install-secret bearer) and stdio; templates, pagination, `lastModified`, `subscriptions/listen`; `brain://source/…` resources; conformance run | `SOURCE_KIND_MCP` | G5 |
| **W3 Local agent** | `@inite/brain-agent` from the repo-indexer runner; `fs` + `git` (now also emitting the repo's docs as documents) + `mcp(stdio)` + `db` (DSN stays local); local redaction; `.mcpb`, plugin skill + hook, installer target, CLI, a CI recipe (GitHub Action / GitLab job); docs both locales | agent config | G6 |
| **W4.5 Wikis** | `notion` (a public integration: Basic + strict JSON, no PKCE, no refresh; search as the catalogue, the block tree as text, `rootPageIds` subtrees) and `confluence` (Atlassian 3LO with `offline_access`, the site from accessible-resources, spaces, storage format → text) as connected accounts into `web_memory` — **shipped (#642)** | `SOURCE_KIND_NOTION`, `SOURCE_KIND_CONFLUENCE` | the wiki row of § 5.1 |
| **W4.6 Mail** | `mail_memory` — a new source pack (what people SAY in mail: `requested`, `committed_to`, `decided`, `deadline`, `discussed`) and the first natives on the conversation door: `gmail` (the Gmail REST API as the connected Google account, one row per message, `messages.list` + `after:<since>`, deletions from the history feed, `format=raw` → one turn; `gmail_attachments` → the evidence plane) and `imap` (a dependency-free minimal client — LOGIN / EXAMINE / UID SEARCH / UID FETCH over TLS, a UID watermark per mailbox, the RFC 5092 URL as the locator; not CONDSTORE/QRESYNC, not attachments) — a message is one turn of its thread (sender as speaker, quotes and signatures stripped) — **shipped (#645)** | `SOURCE_KIND_GMAIL`, `SOURCE_KIND_IMAP` | the mail row of § 5.1 |
| **W4.7 Chat** | `chat_memory` — a second conversation pack (what people say in chat: `asked`, `agreed`, `decided`, `took_on`, `blocked_by`, `discussed`) and two natives on the conversation door: `slack` (Web API as the workspace's bot token — OAuth v2 without refresh or PKCE, or a pasted bot token; member channels only, history from `since` then from the checkpoint ts, threads followed into one conversation, mrkdwn + mentions resolved, `ok: false` failures named) and `telegram` (the Bot API's `getUpdates` with the bot token — the first FEED connector: `readsOnlyNew` means acknowledged-as-read, never re-read, never marked gone) — **shipped (#656)** | `SOURCE_KIND_SLACK`, `SOURCE_KIND_TELEGRAM` | the chat row of § 5.1 |
| **W4.8 The forge** | `code_memory` 0.10.0 gains the repository over the API, without a clone: `github_issues` (every issue and pull request one conversation — body + every comment as turns, `updated_at` the revision, so a new comment brings the thread back whole; `labels` / `includePullRequests` narrow it) and `github_docs` (the text files of the tree from one recursive call, the blob sha the revision). A connected GitHub account (a new OAuth provider: form token endpoint that answers JSON only when asked, no PKCE, no refresh) or a token; GitHub Enterprise through `config.baseUrl` — **shipped (#658)** | `SOURCE_KIND_GITHUB` | the forge row of § 5.1 |
| **W4.9 The other forge** | `code_memory` 0.11.0 gains the same pair on GitLab: `gitlab_issues` (every issue AND merge request one conversation — ⚡GitLab numbers them separately and lists them apart, so `gl:<project>#5` and `gl:<project>!5` are two threads walked under one cap; the description + every note as turns, ⚡`system: true` activity notes dropped, `updated_at` the revision) and `gitlab_docs` (the text files of the tree from the recursive listing, the blob id the revision, ⚡the byte cap on the blob because a tree entry carries no size). A connected GitLab account (a new OAuth provider: PKCE and a refresh token that rotates on use; `SOURCE_OAUTH_GITLAB_LOGIN_URL` moves the whole provider — API included — to a self-managed instance) or an access token with `read_api`; a self-managed instance read with a token is `config.baseUrl` — **shipped (#TBD)** | `SOURCE_KIND_GITLAB` | the forge row of § 5.1 |
| **W4 OAuth + cloud natives** | outbound OAuth 2.1 client; encrypted `credential`; `CredentialProvider` (own \| Nango); Drive (changes API), OneDrive/SharePoint (Graph delta), Dropbox, Gmail (history) + IMAP (→ `mail_memory`, conversation door), Notion, Confluence, Slack + Telegram bot (conversation door), GitHub / GitLab **API** (issues, PRs, wiki, files; webhooks — code structure stays on the agent), `db` (server host), `crm_memory` pack | `SOURCE_OAUTH_CLIENT`, per kind | G4 |
| **W5 G6 steps 3–5** | the membership plane: `external_identity` / `external_principal` (Zanzibar tuples) / `scope_epoch` (0161); `Connector.principals()` with GitLab as the first writer; an item's `acl.groups` → `team:<connection>:<group>` on every row it produces, declared ONCE around the door as an ambient write scope rather than threaded through five signatures (and carried on the asset for the binary door's job); the read fence expanded per request by the guard, multi-tag (`ALLINSIDE`) and fail-closed on a miss; ⚡tenant-wide authority is the tenant boundary and carries no scope clause (the old `scope = []` branch stopped agreeing with the userId fence once ownerless rows carry group tags); an operator links accounts to users, nothing guesses; revocation is a timestamp that moves the epoch (the new-enemy problem); leakage red-team of six — **shipped (#TBD)** | `SOURCE_PRINCIPALS` writes, `SCOPE_TAGS_ENABLED` reads | G8 |
| **W6 Progressive indexing + parsers** | manifest-only default for org connections; JIT deepening from retrieval; budgets; `docling` + remote-parser adapters | `SOURCE_PROGRESSIVE`, `EVIDENCE_PARSER_<X>` | cost |
| **W7 Linked lane** | `search`-capable sources as a retrieval lane; hits recorded as tool observations (0111) | lane in profile | linked mode |

W0–W1 are the spine. W2 + W3 give personal use with **no OAuth at
all** (folders, local MCP servers, a fully-local brain). W4 starts the
cloud story and the money. W5 reuses a design that already exists.

## 7. Measurement

| Leg | Method | Pass |
|---|---|---|
| Sync-correctness matrix | per connector: add / modify / rename / move / delete / restore / permission-change × full / incremental | expected `source_item.state` and fact `validFrom`/`validUntil` in every cell |
| Idempotency | run twice over an unchanged source | 0 rows written, 0 LLM calls |
| Freshness | change at source → fact queryable | p95 ≤ schedule + processing; watch paths ≤ 60 s |
| Cost | tokens + parser $ per 1K items by `contentPolicy` | manifest ≈ 0; text within budget |
| Leakage red-team | two users, one org connection, disjoint ACLs, 200 adversarial queries | 0 cross-user hits (extends the R3 tenant-iso suite) |
| End-to-end QA | synthetic corpus with a known fact sheet (3 languages) synced via fs, MCP, agent; questions through `search_knowledge` | ≥ the same corpus pushed manually — the source layer must not lose accuracy relative to push |
| Drift | edit a synced doc, re-sync | old-revision facts marked `source_version_drift`, new ones current |
| Pack retrofit | `code_memory` with a `sources` entry | `pnpm indexer:repo` byte-identical behaviour |

## 8. Decisions for the owner (recommendations first)

1. **A source is a pack — the manifest grows a `sources` section; no
   separate connector registry?** Recommend yes: `code_memory` proves
   the shape, and consent / signing / registry / marketplace come free.
2. **Third-party seam = MCP only; natives = platform code?** Recommend
   yes — the anti-DSL doctrine applied to sources; a declarative REST
   connector spec would be a DSL we maintain forever.
3. **Personal credentials: agent-side only, or may the cloud brain hold
   a user's Drive token?** Recommend both, decided per connection by
   `host`; a personal cloud connection is still user-fenced.
4. **Own OAuth client or Nango from day one?** Recommend own for the W4
   five behind `CredentialProvider`; Nango optional for the long tail.
5. **Defaults** — `contentPolicy: text` for personal, `manifest` for org;
   `deletePolicy: close` (a deleted file is history, not a lie).

## Sources

- MCP 2026-07-28 — Resources: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- MCP 2026-07-28 — Subscriptions (`subscriptions/listen`): https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
- MCP 2026-07-28 changes (stateless, GET stream removed): https://blog.modelcontextprotocol.io/posts/2026-07-28/ · https://workos.com/blog/mcp-stateless-spec-2026-07-28
- Onyx connector lifecycle: https://deepwiki.com/onyx-dot-app/onyx/3.2-supported-data-sources · https://docs.onyx.app/admins/connectors/overview · oversized ACLs as sync errors: https://github.com/onyx-dot-app/onyx/pull/14811
- Glean permissions-aware architecture: https://docs.glean.com/security/security-principles · https://docs.glean.com/security/how-code-search-works
- ChatGPT linked vs synced connectors: https://help.openai.com/en/articles/10948259-google-drive-synced-connectors-self-service-setup
- Supermemory connectors: https://supermemory.ai/docs/connectors/overview
- Nango: https://nango.dev/ · https://github.com/NangoHQ/nango
- `.mcpb` desktop extensions: https://github.com/modelcontextprotocol/mcpb · https://claude.com/docs/connectors/custom/desktop-extensions
- Khoj desktop folder sync: https://docs.khoj.dev/clients/desktop/ · https://github.com/khoj-ai/khoj
- Parser benchmarks 2026: https://www.llamaindex.ai/blog/parsebench · https://llms.reducto.ai/document-parser-comparison · https://llms.reducto.ai/best-document-processing-apis-2026
