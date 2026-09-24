# The decision plane

Most of brain's LLM calls are not generations. They are **decisions**: same
entity or not, does this evidence support that claim, which predicate slot is
this, which of these candidates is the more relevant. The code already knew it —
seven of the eight call sites that name a `reasoning_effort` ask for `none`,
which is the chat API's way of saying *there is nothing to write, just answer*.

Asking a chat model for those answers costs a text generation every time: a
prompt, hidden reasoning tokens, a JSON envelope to parse, and a verdict with no
number attached to it. When the model is unsure it says `"unsure"` — a word, not
a probability, so nothing downstream can weigh it.

A **System One model** answers the same question as typed output with a
calibrated distribution, in about a tenth of the time, billed on input only.
This plane is where those calls live.

## The contract

`src/ai/decisions/decision.types.ts` — three primitives, taken from the shape
[TypeSafe's Jev](https://docs.typesafe.ai) exposes, because that is the model
the plane was built for:

| Primitive | Question | Answer |
|---|---|---|
| `noul` | Is this statement true? | `noul: 0..1` |
| `choice` | Which option? | `choice`, `probabilities`, `confidence` |
| `score` | Where on this rubric? | `score`, `legend`, `probabilities`, `confidence` |

One request carries one **state** and a map of **questions**, all evaluated
against that state in parallel. Adding questions barely moves the latency and —
output being free — barely moves the bill, so a lane that used to ask one
coarse question can ask ten precise ones.

`certaintyOf()` folds the three shapes onto one 0..1 scale: for a `noul` it is
the distance from the coin flip (0.95 → 0.9), for the other two it is the
concentration the model reports.

## Two rules every lane follows

**A decision plane that is off must change nothing.** `decide()` returns `null`
when the lane is not opted in, when there is no key, when the call failed, or
when the answer map came back short of a question that was asked. `null` means
*take the path you had*, never *the answer is no*. A judge that silently
degrades into a default verdict is a quality regression nothing would catch.

**A decision below the floor is not a verdict.** `confident(lane, answer)` gates
on `DECISIONS_CONFIDENCE_FLOOR` (per lane via
`DECISIONS_CONFIDENCE_FLOOR_<LANE>`). Below it, the lane escalates to the
reasoning model it used before. That escalation is the whole bargain: the easy
cases — which are most cases — settle at a tenth of the latency and a fifth of
the price, and the hard ones still reach the expensive model. Calibration is
what makes this sound; it is also why a calibrated probability is worth more
here than a better verdict would be.

## Lanes

Opted in one at a time through `DECISIONS_LANES` (or `all`), because "is this
lane better on the decision plane" is a measurement per lane **and per
language** — the model's own documentation says non-English is weaker, and this
graph is multilingual. Ship a lane when its battery says so, not before.

| Lane | Judgement | Shape |
|---|---|---|
| `entity_judge` | Are these two entities one thing? | `choice` same/different |
| `verifier` | Is the answer grounded in the evidence? | `choice` supported/partial/unsupported (+ `noul` coverage) |
| `predicate_identity` | Which existing predicate names this attribute? | `choice` over the shortlist + `none` |
| `predicate_semantics` | Is this predicate single-active or append-only? | `choice` |
| `reranker` | How relevant is this candidate? | `score` |
| `chat_router` | Which handler takes this turn? | `choice` |
| `dream_resolver`, `dream_corroborate` | Dedup and corroboration calls | `noul` |

Built so far: `entity_judge`, `verifier`, `predicate_identity`.

### The entity judge

Two options, not three. "Unsure" was never a third kind of answer — it is what a
confidence below the floor MEANS, and asking a model to introspect its own
uncertainty in a JSON enum is a worse estimator than a calibrated distribution.
Below the floor the pair escalates to the reasoning judge.

### The predicate identity judge

The shortlist becomes one option per candidate plus `none`, which is the shape
the judgement always had — the chat version asked for "the exact id or null" and
had to be fenced against invented ids afterwards. The lane returns `undefined`
rather than `null` when it has no confident answer, because `null` is itself a
verdict here ("no existing predicate names this attribute"); merging two
distinct attributes silently destroys one of them, so an uncertain decision goes
to the reasoning judge rather than to a default.

### The verifier

The plane runs FIRST and can only **clear** an answer: `supported`, above the
floor, and (when topic coverage is on) with the coverage question answered.
Anything else — a `partial` hunch, an `unsupported` hunch, an uncertain
decision, a missing coverage judgement — falls through to the auditor. That
asymmetry is deliberate:

* the auditor is the only call that can quote the offending spans
  (`unsupportedClaims`), and a contested answer is exactly when those are worth
  paying for;
* a cheap model that can condemn an answer would turn a miscalibration into a
  silent abstention, which reads to a user as "the memory does not know".

## Cost and latency, measured

| | gpt-5.6-luna (today) | gpt-6-luna | Jev 1.13 |
|---|---|---|---|
| input / 1M | $0.20 | $0.10 | $0.042 |
| output / 1M | $1.20 | $0.50 | free |
| cached input / 1M | $0.02 | $0.01 | — |
| a trivial call | ~1.2 s | ~1.0 s | ~0.1 s (published) |

Rate limits on the decision plane are 1,200 requests/minute and 250k
tokens/second; state is capped at 32k tokens with a 64k total request window,
which is why a lane hands it rendered evidence rather than a whole tenant.

## Operating it

```
TYPESAFE_API_KEY=...            # without it every lane stays on the chat model
DECISIONS_LANES=entity_judge    # or a comma list, or `all`
DECISIONS_CONFIDENCE_FLOOR=0.7  # per lane: DECISIONS_CONFIDENCE_FLOOR_VERIFIER=0.9
```

Through OpenRouter instead of a second vendor account — same protocol, same
answer shape, one bill:

```
TYPESAFE_BASE_URL=https://openrouter.ai/api
TYPESAFE_API_KEY=sk-or-...      # the OpenRouter key
TYPESAFE_MODEL=jev-latest       # bare ids map into OpenRouter's `typesafe/` namespace
```

OpenRouter additionally returns `usage.cost` — the money the decision actually
spent — which lands on the span as `gen_ai.usage.cost` rather than being
reconstructed from a price table that goes stale.

Every decision emits a `gen_ai.decide.<lane>` span carrying the lane, the
question count and the token usage, next to the `gen_ai.chat.*` spans of the
model it replaced — so the two can be compared on the same dashboard.
