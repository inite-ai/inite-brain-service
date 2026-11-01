# Service level objectives

What "Brain is working" means in numbers, how it is measured, and what
happens when the numbers slip. The rules live in
[`monitoring/grafana/provisioning/alerting/rules.yaml`](../monitoring/grafana/provisioning/alerting/rules.yaml)
(section `SLOs`); `test/http-metrics.unit-spec.ts` pins them to the
exported metrics and to this page.

## SLIs

| SLI | Good events | Valid events | Source |
| --- | --- | --- | --- |
| Availability | requests answered without a 5xx, and MCP tool calls that did not end in an internal error | every HTTP request except the probes (`/health`, `/ready`, `/metrics`) | `brain_http_requests_total`, `brain_mcp_tool_calls_total{outcome="internal_error"}` |
| REST latency | interactive requests finished within 5 s | interactive REST routes: everything except probes, `/mcp`, synthesis and multi-hop, `/v1/answer`, document ingest, admin, live streams and source connections | `brain_http_request_duration_seconds` |
| MCP tool latency | interactive tool calls finished within 5 s | every tool except the model-bound ones (`synthesize`, `search_multi_hop`, `agent_qa`, `summarize_entity`, `detect_contradiction`, `why`, `ingest_document`, `submit_memory_work`) and `other` | `brain_mcp_tool_duration_seconds` |

An MCP tool failure returns HTTP 200 with `isError`, so the HTTP status
alone would count it as good; the availability SLI adds the tool's
internal errors. A `tool_error` (the tool's own refusal) and a
`client_error` (validation, not found, policy denial) are the caller's,
not the service's, and do not spend the budget.

Labels are bounded: `route` is the matched route template, a request no
route matched is `unmatched`, status is a class, and a tool outside the
static action registry is `other`.

## Objectives

Over a rolling 30 days:

| SLO | Target | Error budget |
| --- | --- | --- |
| Availability | 99.5 % | 0.5 % of valid events (≈ 3 h 36 min of full outage) |
| REST latency | 95 % within 5 s | 5 % of interactive requests |
| MCP tool latency | 95 % within 5 s | 5 % of interactive tool calls |

The latency targets are initial. They are set wide on purpose: on the
single production droplet the cross-encoder and the embedder share two
vCPUs, and a target tighter than what the hardware delivers would page on
the hardware, not on a regression. Re-set them from 28 days of the new
histograms (the p95 per route class, rounded up to the next bucket edge),
and only to a bucket edge (`HTTP_DURATION_BUCKETS`).

## Alerts

Multi-window, multi-burn-rate (Google SRE Workbook, ch. 5). Burn rate =
observed bad ratio ÷ allowed bad ratio; each alert needs both windows
above its rate, so it fires only while the budget is really going and
clears soon after a fix.

| Alert | Burn rate | Windows | Budget spent at firing | Minimum bad events | Severity |
| --- | --- | --- | --- | --- | --- |
| `AvailabilitySLOFastBurn` | 14.4× | 1 h and 5 min | 2 % | 5 | critical |
| `AvailabilitySLOSlowBurn` | 6× | 6 h and 30 min | 5 % | 10 | critical |
| `AvailabilitySLOBudgetDrain` | 1× | 3 d and 6 h | 10 % | 20 | warning |
| `LatencySLORestBurn` | 6× | 6 h and 30 min | 5 % | — | warning |
| `LatencySLOMcpBurn` | 6× | 6 h and 30 min | 5 % | — | warning |

Production traffic is light, so a ratio alone would page on a single
failed request. The availability alerts also require a minimum number of
bad events in the long window; that is a third term of the same `min()`.

## Error budget policy

- **Budget left:** ship as usual.
- **A fast or slow burn fires:** stop the line. The next release is a fix
  or a rollback (`deploy-brain.yml` deploys the release tag; rolling back
  is re-running it for the previous tag). Write a short incident note in
  the PR that fixes it: what burned, how much, why.
- **Budget exhausted for the window:** releases carry only reliability
  fixes until the 30-day ratio is back under target. Feature work may
  merge to `main`; it is not released.
- **Budget drain warning:** look within the working day. It means the
  window will be missed at the current rate, not that anything is down.

## Dashboards

The "Brain Overview" dashboard has request rate, error ratio and p95
latency by route, and tool calls by outcome.
