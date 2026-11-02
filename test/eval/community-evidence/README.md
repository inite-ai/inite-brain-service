# Community-evidence battery (#876)

Do thematic questions ("what are the main themes", "summarise the payments
project") reach the community summaries the dreams pass builds, and do
factoid questions stay out of them?

Keyless: the real app against a real SurrealDB, the production embedder
(bge-m3) and noise filter (local cross-encoder), in-thread. No paid model.
The community summaries are written by the harness agent, as harness mode
does.

```bash
SURREALDB_URL=ws://127.0.0.1:8000/rpc pnpm eval:community-evidence [--json]
MULTILINGUAL_LANE_ROUTING=1 SURREALDB_URL=… pnpm eval:community-evidence
```

## Rule (fixed before measuring)

- **thematic served**: the question routes to the summary lane AND a gold
  community is among the insight lines (`*` = any community);
- **factoid cost**: community lines a factoid question pulls into the prompt;
- **stale**: a community whose members gained an edge after its build never
  serves.

## Results (2026-11-02, 8 communities, 11 thematic + 8 factoid questions)

| Routing                             | thematic served | en  | ru  | pt  | factoid with community lines | stale skipped |
| ----------------------------------- | --------------- | --- | --- | --- | ---------------------------- | ------------- |
| before the thematic patterns        | 3/11            | 3/7 | 0/2 | 0/2 | 0/8                          | 1/1           |
| default (regex + thematic patterns) | **6/11**        | 6/7 | 0/2 | 0/2 | **0/8**                      | **1/1**       |
| `MULTILINGUAL_LANE_ROUTING=1`       | **9/11**        | 6/7 | 1/2 | 2/2 | 0/8                          | 1/1           |

Whenever a thematic question routed to the summary lane, the gold
community was the **first** line served. The remaining misses are
routing, not retrieval: "What do we know about the running and the knee?"
(no summary cue), and under the classifier one Russian question went to
the temporal lane. Non-English thematic questions reach the lane only
through the multilingual classifier, which is off by default; it also
routed five factoid questions to other lanes (temporal, preference), which
is why it is not switched on here.
