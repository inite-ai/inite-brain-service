# Predicate consolidation: what it does to answers

Measured 2026-09-14 on the memory-fitness battery, 9 tenants built from
one corpus, paired design.

## The design

Three arms per tenant, same tenant, same 31 scored questions:

| arm | state |
|---|---|
| **A** | fresh ingest |
| **B** | re-asked, nothing changed |
| **D** | re-asked after the consolidation pass |

`A→B` is the **noise floor**: nothing about the tenant changed between
those two runs, so every flip is the answer path disagreeing with
itself. `B→D` is the effect. Both are paired per question per tenant, so
a flip is a real disagreement and not a difference of denominators.

This matters because the first attempt at reading this measurement had
no floor, and the number it produced — "6 flips, consolidation works" —
was inside it.

## Result

```
A→B  noise floor      10/279 flips = 3.6%    net  +0  (+5 / -5)   p = 1.00
B→D  the pass         39/279 flips = 14.0%   net +23  (+31 / -8)   p = 0.0003
```

McNemar exact, two-sided. Pass rate **71.3% → 79.6%**, and every one of
the nine tenants improved (sign test p = 0.0039).

The floor came out at exactly net zero (+5/−5) across 279 paired
questions, which is the strongest evidence available that the design is
sound: an arm where nothing changed produced no drift in either
direction, so the +23 is not a measurement artefact.

### By dimension

```
D1 currency      +9     D6 conflict      +2
D2 evolution    +11     D4, D7, D8       +1 each
                        D5, D9           -1 each
```

D1 is the pre-specified target — "what is the value NOW". It moves from
38.9% to 63.9% (+12/−3, p = 0.035). D2 (evolution — "what did it used to
be") moves with it, which is the same mechanism seen from the other
side: a slot with two active values can answer neither question.

### Deterministic counters

```
169 predicates merged
240 facts re-pointed onto a canon
164 contested slots found, 51 re-resolved, 57 stale values retired
```

`slotsResolved` is 51 of 164 because only `single_active` slots are
settled: `append_only` has nothing to resolve, and `bitemporal` needs
the resolver's cosine and margin, which a retroactive pass cannot
reconstruct. The 51 matched an independent DB query of contested
`single_active` slots on three tenants exactly (6/8/4 → 5/8/4).

## What the arms separate

An earlier run on the same tenants had the re-resolve half silently
disabled (a cold registry cache — see the commit), which accidentally
produced a clean C arm: merges applied, nothing re-resolved.

```
B  before the pass                          72.0%
C  names merged, nothing re-resolved        74.2%   (+2, inside the floor)
D  + contested slots re-resolved            79.6%
```

Merging names is bookkeeping. **Co-locating facts is not the same as
adjudicating them**, and it is the adjudication that answers questions:
a fact keeps the status it was written with, so a slot holds several
active values whatever its name, and the merge alone just puts them in
one place.

## Two traps this measurement walked into

Both produced plausible numbers, which is why they are worth recording.

**A stale `dist/`.** The e2e compiles from source through ts-jest, so it
went green while the stand ran the previous build. The reported counter
was `repointed=0`. The run script now builds first and asserts the
artefact carries the change before booting.

**An OOM-degraded database.** 43 accumulated eval tenants OOM-killed
SurrealDB (exit 137) mid-run, and the arms it left behind read A=25/32,
B=15/31, D=6/31 with a 500 from the consolidate call — data shaped
exactly like a catastrophic regression. It was discarded. The run script
now drops stale eval databases first (after killing any stray server,
which otherwise re-provisions the databases you are dropping), and the
analysis refuses any tenant whose B arm collapses against its own A.
