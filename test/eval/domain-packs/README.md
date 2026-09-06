# Domain-pack battery

Third mechanical battery, sibling of
[`test/eval/memory-fitness`](../memory-fitness/README.md) (general
first-person memory fitness, eight dimensions over one corpus) and
[`test/eval/state-transitions`](../state-transitions/README.md) (memory
tracks a mutable world-state). This one isolates a claim neither
sibling touches: **memory behaves correctly WITH industry Domain Packs
installed** — the install → vocabulary → trace chain works end to end,
and ONE entity living in TWO domain ontologies stays a single entity
whose facts, timeline, and provenance keep their per-domain identity.

It is the **first live exercise of that chain**: the six industry packs
(`fintech`, `medical`, `legal`, `insurance`, `real_estate`, `hr`) ship
frozen at v0.1.0 with zero installs anywhere; only the builtin
`code_memory` pack has ever seeded predicates. The battery installs
`fintech` + `medical` into a fresh tenant and measures what actually
happens.

## The multi-domain trace core

One userId (`dp-agent`), one shared subject: **"Meridian Clinic"** — an
org that is deliberately BOTH a fintech client (its payments arm:
EMI license, FCA, PCI-DSS, T+2→T+1 settlement) and a medical provider
(its clinical side: indications, dosing, routes) — plus a person
"Dr. Vega". Four conversations (~20 turns): one per domain (each ending
in a transition on a pack predicate), one generic (domain-free), and
one deliberately MIXED conversation weaving both domains, so the
entity's timeline genuinely interleaves fintech and medical events in
time. Predicate ids are **derived from the real pack manifests at build
time** (`src/ai/domain-packs/{fintech,medical}.pack.ts`) through a
guard that throws on manifest drift — the corpus can never reference an
ontology that doesn't exist.

Why one entity in two ontologies: per-domain entity duplication, domain
cross-contamination in serving, and provenance that loses its domain
identity are exactly the failures a domain-pack platform can introduce
— and none of them are visible while every eval corpus lives inside a
single domain.

## Check battery (all mechanical — see `types.ts` / `scorers.ts`)

| id      | kind             | What would falsify the claim                                                                                                      |
| ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| c01     | install          | phase 0 "succeeded" but the packs are not in the installed list                                                                   |
| c02-c05 | pack-vocab       | domain phrasing coined an open-vocab predicate instead of the exact `fintech__*` / `medical__*` id (baseline finding — see below) |
| c06-c07 | pack-transition  | T+2→T+1 / 500 mg→850 mg loses a stage or reorders (sibling `checkHistorySequence`)                                                |
| c08     | cross-entity     | the clinic splits into per-domain entities, or one domain's facts are missing from the single entity                              |
| c09-c10 | trace-provenance | a fintech/medical fact does not unroll to its OWN domain's seeded turn (sibling `walkProvenance`)                                 |
| c11     | trace-interleave | the shared timeline lacks a domain, or one domain sits entirely before the other (no genuine interleave)                          |
| c12     | serve-cross      | "Tell me about Meridian Clinic" serves only one domain (or abstains on a richly-known entity)                                     |
| c13-c14 | serve-isolation  | a settlement question confabulates doses, a dosing question confabulates fintech values                                           |
| c15     | no-rogue-tools   | tools/list exposes a `__`-namespaced pack tool although no installed pack declares `mcpTools`                                     |

Scoring reuses the siblings' unit-tested primitives (`containsAnyOf`,
`isAbstention`, `missingKeyPhrases`, `walkProvenance`,
`checkHistorySequence`, `scoreServe`) — one implementation, one truth —
and adds only pack-specific scorers, unit-tested in
`test/domain-pack-scorers.unit-spec.ts`. **No LLM judge, no paid eval**
— the only model spend is the stand's own extraction + serving cost
(~20 mention extractions + 3 synthesize calls, well under $1 per run
on the default stand models).

## Honest-baseline policy for `pack-vocab`

The four vocabulary checks are annotated `expectedUnknown` (this
battery's variant of the state-transitions `knownFailToday` idea, for
an outcome that has _never been measured_ rather than one known to be
broken): whether mention-path extraction consults an installed pack's
`extractionProfile` has zero prior observations, and today's likely
outcome is that it does NOT — extraction coins open-vocab predicates
(`has_license`) instead of canonicalizing into pack vocabulary
(`fintech__licensed_as`).

**A fail there is the finding, not a defect of the battery.** The
runner still executes the checks, the report records the exact coined
predicates that swallowed each domain value (so the gap is diagnosable
from the scorecard alone), and the scorecard tallies these fails
separately (`failedExpectedUnknown`). A run where they pass is the
signal pack-vocabulary extraction has landed. Everything downstream is
deliberately vocabulary-independent: the cross-domain checks classify
facts **namespace-first, corpus-value-marker-fallback**, so they get
stronger as pack vocabulary adoption grows but stay meaningful before
it.

Similarly `no-rogue-tools` asserts a NO-OP honestly: no pack today
declares `mcpTools`, `memoryModel`, or `seedDocuments`, so the correct
observable is _zero_ `__`-namespaced tools in `tools/list` even with
packs installed (pack tools surface as `<packId>__<tool>` — the
`code_memory__decided` naming law). The day a pack ships tools, this
check flips into a positive assertion (the pack's tools present, no
one else's).

## Running against a local stand

Same stand as the siblings: a booted brain (with its OpenAI key),
driven purely over the wire — **never run in CI** (the runner exits
with a clear message when `BRAIN_BASE_URL` is unset).

Prerequisites beyond the siblings':

- **A FRESH tenant per run** (`BRAIN_COMPANY_ID`) — the battery
  installs packs into it and asserts entity dedup, both of which a
  reused tenant contaminates.
- **The GLOBAL pack registry must hold `fintech` + `medical`** —
  one-time per environment:
  `BRAIN_API_KEY=<registry:publish key> pnpm registry:seed -- --brain-url <url>`.
  Phase 0 installs via `POST /v1/admin/packs/from-registry`; when the
  registry entry is missing it attempts to republish the LOCAL manifest
  (checksum-pinned) through `POST /v1/admin/registry/packs`, and when
  the key cannot publish it **fails with the instruction above** —
  setup is never silently skipped.
- The API key needs `brain:read + brain:write + brain:admin`
  (`registry:publish` too if you want the runner to self-seed the
  registry).

Stand flags that shape coverage:

- `FACTS_API_ENABLED=1` — required for the trace-provenance checks
  (`get_fact_provenance` is otherwise absent; those checks are
  skipped, never silently passed).
- `THROTTLE_DISABLED=1` — recommended: mention ingest and the MCP
  route are rate-capped; without it the runner backs off on 429.
- No scene/belief flags are needed — this battery reads facts,
  timelines, and provenance straight from mention ingest and runs no
  admin builds.

Then:

```bash
BRAIN_BASE_URL=http://localhost:3000 \
BRAIN_API_KEY=... \
BRAIN_COMPANY_ID=<fresh tenant> \
pnpm eval:domain-packs
```

Knobs (`DPEV_` prefix, mirroring the siblings' `MEMFIT_`/`STEV_`):
`DPEV_USER_ID` (default `dp-agent`), `DPEV_RUN_ID` (default
time-derived; conversation ids are run-scoped so re-runs never
collide), `DPEV_GUARDRAILS` (`strict`|`lenient`|`off`, default
`strict`), `DPEV_SKIP_INGEST=1` (re-ask an already-ingested run —
requires the same `DPEV_RUN_ID`), `DPEV_REPORT_DIR` (default
`var/domain-packs/`).

The JSON scorecard lands in
`var/domain-packs/domain-packs-<runId>.json` — per-class and
per-check-kind tallies, the phase-0 setup trail, every verdict with
its detail (and the raw served answers), so any verdict is
reproducible from the report file alone.
