# Extraction profile per tenant — design & staging

Status: **design-first, no code.** Blocked on the DB (a tenant-settings store)
which cannot be migrated while a measurement run holds the shared database.

## Why

`EXTRACTOR_DIALOGUE_PROFILE` is a global env flag today
(`extractor-llm.service.ts:78`, `composeSystemPrompt`). Measured on LoCoMo dev-5,
the dialogue profile (open coined predicates, no destructive canonicalization)
beats the closed CRM path by **+9.4pp** (47.6 → 57.0) for conversational personal
memory.

But the brain is multi-tenant with domain packs (`real_estate`, `fintech`,
`insurance`, `hr`, `legal`, `medical`, `code_memory`) that ship an
`extractionProfile` and rely on the **closed** predicate vocabulary +
canonicalization to produce structured facts. Making the dialogue profile
unconditional would regress every one of those tenants — open coined predicates
instead of the pack's structured ontology.

So the choice is neither "global on" nor "global off." It is **per tenant**:
dialogue for conversational memory, closed for structured/domain/CRM. Both paths
stay live — which is also why the destructive predicate-refinement subsystem
(`LocalPredicateSelectorService` + `registry.canonicalize`) is NOT dead code: it
is the closed profile's behaviour.

## What exists to build on

- **The snapshot is already per-tenant.** `PredicateRegistryService.getSnapshot`
  (`:234`) assembles a `PredicateSnapshot` keyed by companyId, and it already
  carries `extractionProfiles: PackExtractionProfile[]` folded from
  `BUILTIN_PACKS` + active `domain_pack` rows (`:553`).
- **`composeSystemPrompt` already takes the snapshot.** The mode selector can
  ride on it — no new parameter through the extractor call chain.
- **No tenant-settings table exists.** `grep` for `company_settings` /
  `tenant_settings` is empty. This is the missing piece.

## The mechanism choice (the one real decision)

Three ways to resolve the per-tenant mode, in increasing storage cost:

1. **Pack-declared, no new table.** Add `mode?: 'closed' | 'dialogue'` to
   `ExtractionProfile`. The snapshot resolves: any active pack demanding `closed`
   → closed (structured domains win — they need their vocab); else the global
   default. **Fails the LoCoMo/conversational case**: a personal-memory tenant
   installs NO pack, so it falls to the default and can never opt into dialogue
   without installing a fake pack. Rejected — it can't express "this tenant is
   conversational" without a pack to hang it on.

2. **Per-tenant setting, new `company_settings` table** (RECOMMENDED). One row
   per tenant: `{ companyId, extractionMode, updatedAt }`, default `closed` so
   every existing tenant is byte-identical until explicitly switched. The
   snapshot reads it (cached with the rest of the snapshot). A conversational
   tenant sets `dialogue`; the LoCoMo eval tenant sets `dialogue`. Explicit,
   reversible, and the table is the natural home for the next per-tenant knob
   too (there will be others). Cost: one migration + one read folded into the
   snapshot load.

3. **Domain-routed.** Reuse the pack/domain router to pick mode by inferred
   domain per ingest. Most flexible, most machinery, and it re-decides on every
   mention rather than being a stable tenant property. Overkill for a binary
   that changes per tenant, not per turn. Deferred.

## Recommended design (mechanism 2)

- **Migration** `NNNN_company_settings.surql`: `company_settings` SCHEMAFULL,
  `extractionMode` (`option<string>`, `ASSERT INSIDE ['closed','dialogue']`),
  default absent → treated as `closed`.
- **Snapshot**: `PredicateSnapshot` gains `extractionMode: 'closed' | 'dialogue'`,
  read in `loadFresh` alongside the pack profiles, folded into `versionHash` so a
  mode flip busts the extractor cache. Read failure → `closed` (never break
  extraction on a settings hiccup, same posture as the pack-profile read).
- **`composeSystemPrompt`**: replace `envFlagEnabled(EXTRACTOR_DIALOGUE_PROFILE)`
  with `snapshot.extractionMode === 'dialogue'`. The `EXTRACTION_SYSTEM_PROMPT`
  operator override still wins.
- **Flag retirement**: `EXTRACTOR_DIALOGUE_PROFILE` becomes a one-release
  fallback default for tenants with no settings row, then is removed. It stops
  being a global boolean and becomes the seed value for the per-tenant column.
- **Admin surface**: a small `PATCH /v1/admin/extraction-mode` (brain:admin) to
  set a tenant's mode, so it is operator-visible rather than a raw DB edit.

## Blocked on

The migration writes to the shared SurrealDB, which a live measurement run holds.
Land it when the harness is free. The source-side (snapshot field + prompt
selector, defaulting to closed = byte-identical) can be written first and is
inert until the migration + a settings row exist — but only if the field is
genuinely consumed on the same change, never as a dead placeholder.

## What NOT to do

- Do not make dialogue the global default — it regresses every domain-pack tenant.
- Do not build mechanism 1: it cannot express a pack-less conversational tenant.
- Do not add the snapshot field without the migration that populates it — a
  read of a non-existent column is a dead field, and dead fields are how the
  config surface rotted to 131 knobs in the first place.
