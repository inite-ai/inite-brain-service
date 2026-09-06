# Deterministic extraction harvest lanes

LLM extraction has a recall lottery: the same turn can yield a fact on
one run and miss it on the next. The harvest lanes close that gap for
two fact classes where determinism is possible — **technical literals**
and **completed state transitions**. Each lane runs AFTER the LLM
extractor's denoise pass and UNIONs extra mention candidates into the
same downstream pipeline (same attribution, dedup, conflict
resolution). No lane adds an LLM call; all are default-off flags in the
[config catalog](operations.md#extractor_--deterministic-harvest-lanes).

## Literal harvest (`EXTRACTOR_LITERAL_HARVEST`)

`src/ai/extractor-internals/literal-harvest.ts` — regex rules over the
turn text emit mention candidates for five technical-literal core
predicates:

| Predicate       | Catches                                           |
| --------------- | ------------------------------------------------- |
| `rate_limit`    | request/rate ceilings ("100 req/s per key")       |
| `service_port`  | service ↔ port bindings                           |
| `http_status`   | endpoint ↔ status-code behavior                   |
| `naming_prefix` | naming conventions ("all queues prefixed `evt_`") |
| `identifier`    | opaque ids, codes, keys                           |

A sixth technical-literal predicate, `duration_limit`, is seeded as an
LLM extraction slot only: its harvest regex ships in the module but is
deliberately excluded from the active rule list as the over-firing rule
of the family. The lane caps at 6 candidates per turn; attribution is
by clause overlap with a speaker fallback.

## State-verb harvest (`EXTRACTOR_STATE_VERB_HARVEST`)

`src/ai/extractor-internals/state-verb-harvest.ts` — a lexicon of
past-tense/completed state verbs (sold, quit, adopted, moved…) emits
`state_change` facts (append-only predicate, confidence 0.95, cap
6/turn).

**Holder binding law**: the fact binds to the person whose state
changed — a PERSON entity named in the sentence when present, else the
speaker — and NEVER to the transitioned object. "Anna sold the bike"
is a state change OF ANNA (the bike is inside the harvested span);
binding it to the bike scatters one person's transitions across object
entities and makes the timeline unreadable. Intention forms
("is planning to sell", "listed the bike") are deliberately outside the
lexicon: an intention is not a completed transition.

## Transition classifier (`EXTRACTOR_TRANSITION_CLASSIFIER`)

Module only — NOT wired into the extraction pipeline in this release;
the flag is an availability gate, and thresholds are exported defaults
pending stand calibration. Two pure stages:

1. **Morphology** (`src/ai/extractor-internals/transition-morphology.ts`)
   — compromise-based English morphology finds past-tense,
   non-negated, non-hypothetical verb clauses with a complement.
2. **Semantics** (`src/ai/extractor-internals/transition-classifier.ts`)
   — max-cosine against a fixed EN + RU prototype bank
   (BGE-M3 embeddings carry the language-agnosticism), classifying
   `completed_acquire | completed_dispose | completed_change |
intention | unrelated`.

## See also

- [Operations](operations.md#extractor_--deterministic-harvest-lanes) —
  the `EXTRACTOR_*` flag table (all default-off).
- [Data model](data-model.md) — predicate vocabulary + conflict
  resolution the harvested facts flow into.
- [Eval methodology](eval-methodology.md) — the mechanical battery
  (`eval:memory-fitness`, `eval:state-transitions`) that measures what
  these lanes fix.
