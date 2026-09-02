# Fact read + provenance API

"Show me why I remember this." Two read endpoints over `knowledge_fact`:
the fact as stored, and the verbatim conversation turns it was derived
from. Both are gated by `FACTS_API_ENABLED` (default off → the routes
answer 404, indistinguishable from absent routes). The existing
`POST /v1/facts/:id/retract` is deliberately **not** gated by this flag —
it is a write/GDPR path and must always work.

## Positioning

The market has learned to distrust silent fact-mining: memories extracted
behind the user's back, served with no way to ask "where did this come
from?" (Cursor removed auto-extracted memories over exactly this).
This platform keeps episode-level provenance for every derived fact —
`source.episodeIds` points at the verbatim L0 turns the extraction was
grounded in — and this API turns that stamp into a contract. Every
remembered statement can be traced to the exact dated, attributed
utterances behind it, and every retraction stays visible as a retraction.
Provenance-first memory is the trust counter-position to silent
fact-mining: not "trust the model", but "check the transcript".

## Endpoints

### `GET /v1/facts/:id`

Scope: `brain:read`. Policy action: `get_fact`.

`:id` accepts both the short id (`f1`) and the full record id
(`knowledge_fact:f1`).

```json
{
  "factId": "knowledge_fact:f1",
  "aspect": "preference",
  "statement": "likes hiking in the mountains",
  "confidence": 0.92,
  "validFrom": "2026-08-01T00:00:00.000Z",
  "userId": "u2",
  "kind": "fact",
  "vertical": "dialogue",
  "recorder": "session-deriver-v1",
  "conversationId": "conv-1",
  "retracted": false,
  "derivedVersion": "wd-v3s",
  "groundingStatus": "grounded"
}
```

- `aspect` / `statement` are the stored `predicate` / `object`.
- `kind`, `vertical`, `recorder`, `conversationId` come from the fact's
  `source` stamp and are present only when stamped.
- `userId` is the per-user memory scope (migration 0055); absent =
  tenant-global.
- `groundingStatus` (`grounded` | `ungrounded`, migration 0115) is the
  claim-grounding state stamped by servers running
  `EVIDENCE_GROUNDING_STAMP`: `grounded` = the source names an
  observation (episode ids in `source.episodeIds`, non-empty
  `source.evidence[]`, or a `source.conversationId`); `ungrounded` =
  explicitly observation-free. Absent = legacy row (predates the stamp
  writer) — additive, never backfilled.
- Retracted facts still resolve, with `retracted: true` — what was
  un-remembered and why it disappeared is part of the trust story.

### `GET /v1/facts/:id/provenance`

Scope: `brain:read`. Policy action: `get_fact_provenance`.

Serves the grounding turns listed in the fact's `source.episodeIds`,
fetched through the shared episode read port (one PII fence + user gate
implementation), chronological, with each turn's text capped at 600
characters:

```json
{
  "factId": "knowledge_fact:f1",
  "episodes": [
    {
      "episodeId": "episode:e1",
      "conversationId": "conv-1",
      "speaker": "Caroline",
      "occurredAt": "2026-07-01T10:00:00.000Z",
      "text": "I love hiking, we should plan a trip!"
    }
  ]
}
```

A fact with no grounding stamp (e.g. directly recorded via the write
API) serves an empty `episodes` list.

### Read-flag extensions: closure + support edges

Three additive response fields appear when the server enables the
corresponding read flags (absent — not empty — otherwise, so plain
deployments stay byte-identical):

- `derivedFacts` + `closure` (`PROVENANCE_RECURSIVE_CLOSURE`, default
  off): for a fact WITH `derivedFrom`, the walk serves the transitive
  support graph — each supporting fact as `{factId, predicate, depth,
  status}` (compacted / retracted members still witness; status is
  reported, not hidden) and a `closure` summary `{depth, factCount,
  truncated, filtered}`. The `episodes` list becomes the union of
  grounding episodes across the closure. Every member passes the same
  visibility fences as the root; an invisible member is a SILENT drop
  marked `filtered: true`. Traversal depth is server-side policy
  (`PROVENANCE_CLOSURE_MAX_DEPTH` / `_FACTS` / `_EPISODES`), not a
  caller knob.
- `supportEdges` (`PROVENANCE_SUPPORT_GRAPH_READ`, migration 0116): the
  typed `memory_support` edges the walk crossed, each `{kind, from,
  to}` with full record ids:

| Kind | Direction (`in` = the claim being supported) |
| --- | --- |
| `supported_by` | fact → the `memory_episode` scene that witnessed it |
| `contradicted_by` | loser fact → winner fact (COMPETING writes the mutual pair) |
| `derived_from` | summary fact → member fact (typed mirror of the untyped `derivedFrom` array) |

The `memory_support` substrate vocabulary reserves a fourth kind,
`reconstructed_from` — scene membership stays in
`memory_episode_member` (0106), NO writer emits it (the edge-shape
guard rejects it), and the wire enum deliberately excludes it. If it
ever appears in a response, that is a bug, not a new feature.

The MCP twin `get_fact_provenance` is a passthrough of this response —
no field filtering.

## Auth semantics

Every visibility miss is a **404, never a 403** — a 403 would confirm
the row exists.

| Fence | Behavior |
| --- | --- |
| Flag | `FACTS_API_ENABLED` off (default) → 404 on both GET routes. Runtime-mutable. |
| Tenant | The read runs inside the caller's per-tenant database (same fence as retract); a foreign tenant's fact id is simply not found. |
| User scope (0055) | A user-bound access token reads tenant-global facts and its **own** user-scoped facts; another user's fact → 404. M2M credentials read all. |
| Row policy | The registry-backed row-policy seam shared with the fact retrieval lanes: an operator scope-fenced predicate (`requiresScope`, e.g. `brain:read_pii`) is absent to callers without the scope; ABAC row verdicts apply when a policy context is attached. |
| PII (episodes) | Episode text is served through the L0 read port's PII fence: without `brain:read_pii`, PII-classed turns are omitted from `episodes`. There is no fact-level PII boolean on `knowledge_fact` — fact-level PII is a predicate policy, enforced by the row-policy fence above. |
| Episode user gate | The episode fetch reuses `byIds`' fail-closed user gate, keyed to the fact's own `userId` when the fact is user-scoped (the caller already passed the fact-level gate), else to the caller's pinned user scope. |

## Example

```bash
export BRAIN_KEY=sk_...
curl -s -H "Authorization: Bearer $BRAIN_KEY" \
  https://brain.example.com/v1/facts/f1 | jq .

curl -s -H "Authorization: Bearer $BRAIN_KEY" \
  https://brain.example.com/v1/facts/f1/provenance | jq .
```

Typical agent flow: a retrieval surface cites `factId`s → the consumer
renders "why do you remember this?" → one provenance call returns the
dated, attributed transcript lines to show the user.
