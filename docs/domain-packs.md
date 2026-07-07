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

## The manifest

A pack is a `DomainPackManifest` (`src/ai/domain-packs/manifest.ts`):

```ts
interface DomainPackManifest {
  id: string;            // snake_case, no "__" — the predicate namespace
  version: string;       // semver MAJOR.MINOR.PATCH — bump to ship an update
  description: string;
  predicates: PackPredicate[];   // the ontology this pack contributes
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

CLI:

```bash
pnpm pack:publish  -- --brain-url $URL --file packs/real-estate.pack.json \
                      --keywords real-estate,property   # needs registry:publish
pnpm pack:search   -- --brain-url $URL --q real          # browse (brain:read)
pnpm pack:search   -- --brain-url $URL --versions real_estate
pnpm pack:install  -- --brain-url $URL --registry real_estate[@0.2.0]  # brain:admin
pnpm registry:seed -- --brain-url $URL                   # publish all packs/*.json
```

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
