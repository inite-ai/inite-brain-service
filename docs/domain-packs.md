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

## Roadmap (not built yet)

This phase delivers the **standard + namespacing + the merge loader**. Still
ahead, to make packs fully community-distributable:
- **Runtime per-tenant install/uninstall** — a `domain_pack` table recording
  installed packs + pinned versions per tenant; install/upgrade/rollback API.
- **Distribution** — load packs from JSON manifests / a registry, not only
  compiled modules; signed/checksummed packs.
- **Per-pack eval fixtures + extraction profiles** carried in the manifest.
