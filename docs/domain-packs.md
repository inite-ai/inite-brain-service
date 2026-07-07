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

Still ahead: a discovery **registry**; consuming `evalFixtures` at runtime.
