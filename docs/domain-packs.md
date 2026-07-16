# Domain Packs — the ontology extension standard

> A **Domain Pack** is a versioned, pluggable bundle of ontology that extends
> the brain predicate registry **without forking core**. Packs let a domain
> (code-memory, real-estate, fintech, …) — or the community — ship its own
> typed predicates that brain merges into every tenant's registry. This file is
> the standard third parties conform to.

## Why packs

Brain's predicate registry decides how facts are typed, conflict-resolved, and
decayed (semantics: `single_active` / `append_only` / `bitemporal`). Core ships
a general seed (`name`, `said`, `plan`, …). A domain needs its own vocabulary —
but baking every domain's predicates into the core seed doesn't scale and can't
be community-extended. Packs make the ontology a first-class, versioned plugin.

## Quickstart: author → validate → sign → publish → install

The whole community-author loop, copy-paste ready (details for each step live
in the sections below):

```bash
# 1. Scaffold a valid starter manifest → ./my_pack.pack.json
pnpm pack:init my_pack

# 2. Edit my_pack.pack.json — predicates (TYPE/ADMIT/VALUE cards),
#    extractionProfile, evalFixtures, optional indexer descriptor.

# 3. Validate against the standard + core collision check
pnpm pack:validate my_pack.pack.json

# 4. (optional) Sign as your publisher id — required when the target brain
#    sets DOMAIN_PACK_REQUIRE_SIGNATURE / PACK_REGISTRY_REQUIRE_SIGNATURE
openssl genpkey -algorithm ed25519 -out priv.pem   # once, if you have no key
pnpm pack:sign -- --file my_pack.pack.json --key priv.pem --publisher acme

# 5. Publish into the global registry (key needs the registry:publish scope)
BRAIN_API_KEY=... pnpm pack:publish -- --brain-url https://brain.inite.ai \
  --file my_pack.pack.json --keywords my,keywords --verify

# 6. Install into a tenant (key needs brain:admin) — from the registry…
BRAIN_API_KEY=... pnpm pack:install -- --brain-url https://brain.inite.ai \
  --registry my_pack
#    …or straight from the reviewed local file, checksum-pinned
BRAIN_API_KEY=... pnpm pack:install -- --brain-url https://brain.inite.ai \
  --file my_pack.pack.json --verify

# 7. Score the LIVE extractor against the pack's own evalFixtures
curl -X POST -H "Authorization: Bearer $BRAIN_API_KEY" \
  https://brain.inite.ai/v1/admin/packs/my_pack/eval
```

No PR to this repo is needed for any of it — a community pack is JSON,
published to a registry instance and installed per-tenant.

## The manifest

A pack is a `DomainPackManifest` (`src/ai/domain-packs/manifest.ts`):

```ts
interface DomainPackManifest {
  id: string;            // snake_case, no "__" — the predicate namespace
  version: string;       // semver MAJOR.MINOR.PATCH — bump to ship an update
  description: string;
  predicates: PackPredicate[];   // the ontology this pack contributes
  indexer?: IndexerDescriptor;   // document-pipeline execution (see below)
}

type PackPredicate = {
  localId: string;       // snake_case, no "__"
  displayLabel: string;
  description: string;   // the extractor "card" (TYPE / ADMIT / VALUE)
  datatype: 'string' | 'number' | 'date' | 'datetime' | 'enum' | 'json';
  semantics: 'append_only' | 'single_active' | 'bitemporal';
  decayHalfLifeDays: number | null;
  piiClass: 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
  status: 'active' | 'proposed' | 'aliased' | 'deprecated';
  requiresScope?: string; allowedValues?: string[]; /* …optional */
};
```

## Namespacing (the one hard rule)

Every pack predicate is stored as **`<packId>__<localId>`** — double underscore
is the reserved separator. A pack declaring `id: 'code_memory'` with a predicate
`localId: 'decided'` becomes the registry predicate **`code_memory__decided`**.

Why `__` and not `/` or `:`:
- predicate ids must match `^[a-z][a-z0-9_]*$` (admin CRUD validation) and flow
  through REST path params — `/` breaks routing, `:` collides with record ids.
- `__` stays inside the existing charset, so admin tooling and routing keep
  working unchanged.

**Core predicates are the reserved UNPREFIXED namespace** and are never renamed
(that would orphan existing facts). Packs MUST namespace; the loader enforces it
and **fails the boot on any id collision** (pack-vs-core or pack-vs-pack) rather
than silently shadowing.

## How merge + install works today

- `src/ai/domain-packs/index.ts` lists `BUILTIN_PACKS` and exports
  `SEED_PREDICATES = assembleSeed(CORE_PREDICATES, BUILTIN_PACKS)` — validated +
  collision-checked at module load.
- The predicate registry seeds **`SEED_PREDICATES`** (core + packs) into each
  tenant's `knowledge_predicate` table on first access (idempotent — admin
  overrides survive). `policyFor` falls back to the same merged set.
- So installing a builtin pack = author a manifest module + add it to
  `BUILTIN_PACKS`; its namespaced predicates are seeded into every tenant.

## Authoring a pack

1. Create `src/ai/domain-packs/<your-pack>.pack.ts` exporting a
   `DomainPackManifest`. Use the reference: `code-memory.pack.ts`.
2. Validate it: `pnpm pack:validate path/to/pack.json` (or rely on the unit
   test — `assembleSeed` throws at load on a bad/colliding pack).
3. Register it in `BUILTIN_PACKS` (`index.ts`).
4. Expose ergonomic helpers for consumers (see `codeMemoryPredicateId` /
   `codeMemoryKindOf`) so tools pass local kinds while the registry stores the
   namespaced id.
5. Bump `version` (semver) whenever you change the ontology. Renames/removals
   should go through the registry's alias/deprecate lifecycle, not a hard delete.

## Reference pack

`code_memory` (`src/ai/domain-packs/code-memory.pack.ts`) — the non-derivable
engineering "why" of a codebase: `decided`, `because`, `invariant`, `gotcha`,
anchored to code anchors. See `docs/roadmap/code-memory-domain.md`.

## Distribution + integrity

- **Runtime per-tenant install/uninstall** (shipped) — `domain_pack` table +
  `/v1/admin/packs` (install upserts = upgrade; uninstall deprecates predicates).
- **JSON-manifest install** (shipped) — `pnpm pack:install --file pack.json`
  POSTs a manifest; no compiled module needed. Community packs ship as JSON.
- **Content integrity** (shipped) — every install computes + stores a
  `packChecksum` (sha256 of the canonical, key-sorted manifest). Pass
  `expectedChecksum` (or `pnpm pack:install --verify`) and the server rejects a
  mismatch: "the manifest I install is the one I reviewed".
- **Publisher signatures** (shipped) — an ed25519 `signature` (+ `publisher`)
  over the canonical manifest proves authorship, not just integrity. Sign with
  `pnpm pack:sign --key priv.pem --publisher acme`; the server verifies against
  a trust store (`DOMAIN_PACK_TRUSTED_KEYS` = publisher→PEM) and can require
  signing (`DOMAIN_PACK_REQUIRE_SIGNATURE=true`). Unknown publisher / bad
  signature → install rejected.

## Extraction profiles (consumed)

A pack MAY ship an `extractionProfile` — domain-specific tuning for the LLM
extractor — and, unlike the still-forward-compat `evalFixtures`, it is now
**consumed at extract time**:

```jsonc
"extractionProfile": {
  "guidance": "Real-estate inputs describe properties. Prefer real_estate__* …",
  "fewShot": [
    { "text": "12 Elm St is zoned R-2.", "note": "→ real_estate__zoned_as='R-2'" }
  ]
}
```

- `guidance` — domain framing appended to the extractor system prompt.
- `fewShot` — `{ text, note }` examples rendered as illustrative TEXT (never a
  schema-constrained turn, so they can't break the strict output schema).

Flow: install stores the manifest in `domain_pack`; the predicate registry's
`loadFresh` reads every active pack's profile onto the tenant snapshot
(`extractionProfiles`); `ExtractorLlmService.composeSystemPrompt` appends a
`DOMAIN EXTRACTION GUIDANCE` section AFTER the predicate vocabulary. It is
advisory — the VERBATIM RULE and strict schema still govern. Profiles from
builtin packs (always active) and runtime-installed packs (active `domain_pack`
row) are both included; uninstall drops them.

The first pack to use this is **real_estate** (`src/ai/domain-packs/
real-estate.pack.ts`, distributable JSON at `packs/real-estate.pack.json`) — a
DISTRIBUTABLE pack (installed per-tenant, deliberately NOT a builtin so its
domain predicates don't seed into unrelated tenants).

## Indexer descriptor

A pack MAY declare how it participates in the
[document pipeline](document-pipeline.md) via the optional `indexer` field —
data inside the signed manifest, so signature / checksum / version-immutability
cover it with no extra machinery:

```jsonc
"indexer": {
  "mode": "dedicated",              // 'virtual' (default) | 'dedicated' | 'external'
  "relevance": {                    // routing triggers (dedicated/external only)
    "keywords": ["zoned", "listing"],
    "verticals": ["crm"],           // subscribe to contextRef.vertical values
    "description": "Real-estate documents: listings, zoning, valuations",
    "threshold": 0.3,               // cosine gate for the description layer
    "alwaysRun": false              // config-based subscription (bypass router)
  },
  "dedicated": {
    "includeCorePredicates": true,  // entity typing needs the core cards
    "model": "gpt-4o",              // per-pack model override
    "scPasses": 3                   // per-pack self-consistency budget
  }
}
```

- **`virtual`** (absent descriptor) — the pack rides the single union
  extraction call; its facts are attributed by predicate namespace at zero
  extra LLM cost. This is already "N indexers per document" semantically.
- **`dedicated`** — the pack gets its OWN extraction run over a pack-filtered
  vocabulary + profile: a whole prompt budget for one domain, per-domain model
  choice, independent failure, a distinct cache/calibration identity. Gated
  per document by the relevance router; opt in when
  `POST /v1/admin/packs/:id/eval?mode=dedicated` beats `?mode=union` on the
  pack's own fixtures.
- **`external`** — the pack IS a registration for a remote indexer that stages
  candidates via `POST /v1/documents/:id/candidates` (scope `indexer:write`);
  no in-process extraction runs for it. The builtin `code_memory` pack is the
  reference external indexer — its capture pipeline runs where the code lives.

## The registry (global catalogue)

Packs are published to and installed from a **global registry** — a shared,
tenant-agnostic catalogue in the `system` database (distinct from `domain_pack`,
which records what a tenant has INSTALLED). It closes the loop the pack machine
exists for: **publish → discover → install**.

Invariants (supply-chain safety, npm/crates.io-style):

- **Version immutability** — a `(packId, version)` is content-addressed by
  `checksum`. Republishing the same version with different content → `409`; an
  identical republish is idempotent.
- **Yank, not delete** — a bad version is flagged `yanked` (dropped from
  latest-resolution + default listing, refused for a pinned install) but never
  removed, so pinned installs stay reproducible. `unyank` restores it.
- **Trust end-to-end** — the manifest's `signature`/`publisher` are stored
  as-is; cryptographic verification happens at **install** time against the
  installing tenant's trust store. `PACK_REGISTRY_REQUIRE_SIGNATURE=true` gates
  publishing to signed packs.

Surface:

- **Discovery** (`brain:read`): `GET /v1/registry/packs[?q=&tag=&publisher=]`,
  `GET /v1/registry/packs/:id` (all versions + latest), `GET
  /v1/registry/packs/:id/:version` (`:version` may be `latest`).
- **Publish / yank** (`registry:publish` — a scope distinct from `brain:admin`,
  because it mutates the shared catalogue): `POST /v1/admin/registry/packs`,
  `POST /v1/admin/registry/packs/:id/:version/{yank,unyank}`.
- **Install from registry** (`brain:admin`): `POST /v1/admin/packs/from-registry
  {packId, version?}` — resolves latest-non-yanked (or a pin) and installs via
  the normal path, pinning the registry checksum.
- **Browse** (public, no auth): `GET /registry/ui` — a server-rendered HTML
  catalogue of published packs (ids, versions, keywords, install hint).

CLI:

```bash
pnpm pack:publish  -- --brain-url $URL --file packs/real-estate.pack.json \
                      --keywords real-estate,property   # needs registry:publish
pnpm pack:search   -- --brain-url $URL --q real          # browse (brain:read)
pnpm pack:search   -- --brain-url $URL --versions real_estate
pnpm pack:install  -- --brain-url $URL --registry real_estate[@0.2.0]  # brain:admin
pnpm registry:seed -- --brain-url $URL                   # publish all packs/*.json
```

### Mirroring (pull-only)

A deployment can mirror another instance's registry: set
`REGISTRY_UPSTREAM_URL` (+ optional `REGISTRY_UPSTREAM_TOKEN`, a `brain:read`
key on the upstream) and a background job pulls the upstream catalogue every
`REGISTRY_MIRROR_INTERVAL_HOURS` (default 24; one run at 00:26 UTC) and
republishes missing versions locally through the normal publish path — so
validation, builtin-id squatting protection, version immutability and the
local trust store's `verified` recomputation all apply. Mirrored rows carry
an `origin` marker (the upstream base URL, migration 0064; surfaced in the
API and as *mirrored from `<host>`* in `/registry/ui`).

Rules: **pull-only** (local publishes never push upstream); **local rows
always win** (an id/version that exists locally is skipped); **yanks mirror
one-way** — an upstream yank is applied only to rows whose `origin` matches
that upstream, never to local publishes; every pulled manifest's checksum is
recomputed locally and a mismatch is rejected. Work is bounded (200 versions
per run, 10s per request; per-pack failures don't abort the run). Unset
`REGISTRY_UPSTREAM_URL` (the default) = feature off, no job registered.

## Eval fixtures (consumed)

A pack may ship `evalFixtures` — small extraction test cases for its domain,
now **consumed at runtime** (like `extractionProfile`):

```jsonc
"evalFixtures": [
  {
    "id": "zoning",
    "text": "The parcel at 12 Elm St is zoned R-2.",
    "expect": { "facts": [{ "predicate": "zoned_as", "objectIncludes": "R-2" }] }
  }
]
```

- `text` — the mention run through the LIVE extractor for the tenant (with the
  pack's predicates + extractionProfile active).
- `expect.facts[].predicate` — bare (`zoned_as`) resolves to the pack namespace
  (`real_estate__zoned_as`); an already-namespaced id is used verbatim.
  `objectIncludes` is an optional case-insensitive substring on the value.
  `expect.minEntities` / `minFacts` are coarse thresholds.

Flow: the manifest (already stored in `domain_pack` on install, or shipped for
builtins) → `PackEvalService` runs each fixture through
`ExtractorService.extract` → `scoreFixture` (pure) → a pass/fail report:

```
POST /v1/admin/packs/:packId/eval   (brain:admin)
→ { packId, version, total, passed, results: [{ id, passed, failures[] }] }
```

`real_estate` ships three fixtures (zoning / valuation / tenure) as the
demonstrator. Nothing forward-compat remains in the manifest.

## Seed documents (consumed)

A pack may ship `seedDocuments` — pre-populated domain knowledge that is
**ingested through the normal document pipeline on install** (no bespoke
fact-writing path: seeds get the same chunking, extraction, candidate staging,
conflict resolution and provenance as any connector's document):

```jsonc
"seedDocuments": [
  {
    "localId": "zoning_primer",          // snake_case, unique in the pack
    "title": "Zoning classifications primer",
    "text": "R-1 districts allow …",     // ≤ 65,536 chars each
    "vertical": "real_estate",           // contextRef.vertical at ingest
    "originUri": "https://example.com/zoning",  // optional; default pack://<packId>/<localId>
    "occurredAt": "2026-01-01T00:00:00Z",       // optional; → derived facts' validFrom
    "meta": { "audience": "agents" }     // optional; FLAT scalars only
  }
]
```

Caps (validated by `pnpm pack:validate` and again at install): at most **32**
documents, **65,536** chars per document, **262,144** chars combined. `meta`
keys are snake_case, values scalar ≤256 chars — the bag must survive
`sanitizeSourceMeta` verbatim.

Flow: install stores the manifest → the install hook enqueues a
`pack_seed_ingest` job (flag `PACK_SEED_INGEST_ENABLED`, default ON; also
requires `DOCUMENT_INGEST_ENABLED` since seeds ride that pipeline) → the job
feeds each seed to `POST /v1/ingest/document` semantics with
`kind: 'pack_seed'` and provenance meta stamped on every derived fact's
`source.meta`:

| key | value |
|---|---|
| `pack_seed` | `true` |
| `pack_id` | the pack id |
| `pack_version` | the installed version |
| `pack_seed_doc` | the seed's `localId` |

The install response reports what happened without ever failing the install:
`seedDocuments: { count, status }` with status one of `enqueued`,
`enqueue_failed`, `skipped_flag_disabled`, `skipped_ingest_disabled`,
`skipped_no_queue`.

Idempotency is two-layered: the job's dedupKey is `pack_seed_<id>_<version>`
(a same-version reinstall doesn't re-run a completed ingest), and the document
contentHash UNIQUE index dedups at the text level (a re-run — or an upgrade
whose seed text didn't change — is a per-document no-op). Upgrade semantics
follow: **changed seed texts become new documents**, unchanged ones dedup
silently. Like everything in the manifest, `seedDocuments` is covered by the
pack checksum and signature.

Uninstall leaves seed documents and their facts in place — the same
facts-survive philosophy as predicate deprecation. The provenance meta keys
above make them queryable (`source.meta.pack_id`) for manual cleanup or an
ABAC deny rule.

## First-party pack library (industries)

Beyond the builtin `code_memory`, brain ships a library of DISTRIBUTABLE
industry packs (installed per-tenant, published to the registry via
`pnpm registry:seed`) — each a complete ontology with predicates +
`extractionProfile` + `evalFixtures`, not a stub:

| pack | domain | predicates (namespaced `<id>__*`) |
|---|---|---|
| `real_estate` | property | zoned_as, valued_at, listed_at, encumbered_by, tenure_type, built_in |
| `fintech` | financial-services regulation | regulated_by, licensed_as, complies_with, capital_requirement, settlement_period |
| `medical` | clinical pharmacology (drugs, not patients) | treats, dosed_at, administered_via, interacts_with, contraindicated_with |
| `legal` | contracts | governed_by, party_to, obligation, effective_from, terminates_on |
| `insurance` | insurance policies | covers, coverage_limit, premium, deductible, excludes |
| `hr` | HR / recruiting (roles, not PII) | requires_skill, seniority, compensation, employment_type, work_location |

Sources: `src/ai/domain-packs/*.pack.ts` (the `FIRST_PARTY_PACKS` list) →
committed JSON in `packs/*.pack.json` (drift-guarded by
`test/industry-packs.unit-spec.ts`). Install one with
`pnpm pack:install -- --registry fintech` (after `registry:seed`) or
`--file packs/fintech.pack.json`.
