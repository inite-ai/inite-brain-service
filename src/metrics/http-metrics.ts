import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, type Registry } from 'prom-client';

/**
 * Request-level RED metrics (rate, errors, duration), the SLIs the SLOs in
 * docs/slo.md are computed from. Before this the service exported only
 * domain counters, so "is the API up for callers" had no number: the
 * scrape-up alert saw a live process answering 503 as healthy.
 *
 * Labels stay bounded. `route` is the matched route template
 * (`/v1/facts/:id`), never the raw path; an unmatched request is
 * `unmatched`. Status is a class (`2xx` … `5xx`). Recorded on `finish` or
 * `close`, so a request a guard rejects (401, 403, 429) or a client
 * abandons counts as well; an abandoned one is class `aborted`.
 */

/** Seconds; the SLO thresholds in docs/slo.md sit on bucket edges. */
export const HTTP_DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export interface HttpMetrics {
  requests: Counter<'method' | 'route' | 'status_class'>;
  duration: Histogram<'method' | 'route' | 'status_class'>;
}

/**
 * Registered once per registry: a second caller (a test building two
 * servers on one MetricsService) gets the same instruments back instead of
 * prom-client's duplicate-name throw.
 */
const instruments = new WeakMap<Registry, { http?: HttpMetrics; tools?: McpToolMetrics }>();

function slot(registry: Registry) {
  let s = instruments.get(registry);
  if (!s) instruments.set(registry, (s = {}));
  return s;
}

export function httpMetrics(registry: Registry): HttpMetrics {
  const s = slot(registry);
  return (s.http ??= {
    requests: new Counter({
      name: 'brain_http_requests_total',
      help: 'HTTP requests served, by method, matched route template and status class',
      labelNames: ['method', 'route', 'status_class'] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'brain_http_request_duration_seconds',
      help: 'HTTP request duration until the response finished, by method, route template and status class',
      labelNames: ['method', 'route', 'status_class'] as const,
      buckets: HTTP_DURATION_BUCKETS,
      registers: [registry],
    }),
  });
}

/** The matched route template, as Express knows it once routing ran. */
export function routeOf(req: Pick<Request, 'baseUrl' | 'route'>): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string') return 'unmatched';
  return `${req.baseUrl ?? ''}${path}` || '/';
}

export function statusClass(status: number, finished: boolean): string {
  if (!finished) return 'aborted';
  const c = Math.floor(status / 100);
  return c >= 1 && c <= 5 ? `${c}xx` : 'other';
}

/** Express middleware: one observation per request, on finish or close. */
export function httpMetricsMiddleware(m: HttpMetrics) {
  return function (req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    let done = false;
    const record = () => {
      if (done) return;
      done = true;
      const labels = {
        method: req.method,
        route: routeOf(req),
        status_class: statusClass(res.statusCode, res.writableFinished),
      };
      m.requests.inc(labels);
      m.duration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  };
}

/** How one MCP tool call ended. */
export type ToolCallOutcome = 'ok' | 'tool_error' | 'client_error' | 'internal_error';

export interface McpToolMetrics {
  calls: Counter<'tool' | 'outcome'>;
  duration: Histogram<'tool' | 'outcome'>;
}

/**
 * Per-tool calls: every MCP request is one HTTP route (`/mcp`), so the
 * HTTP SLIs cannot tell a failing `synthesize` from a healthy
 * `search_knowledge`. Tool names outside the static action registry (a
 * tenant pack's own tools, the run_tool dispatcher) share one label value,
 * `other`, so a pack cannot mint series.
 */
export function mcpToolMetrics(registry: Registry): McpToolMetrics {
  const s = slot(registry);
  return (s.tools ??= {
    calls: new Counter({
      name: 'brain_mcp_tool_calls_total',
      help: 'MCP tool calls by tool and outcome (ok, tool_error, client_error, internal_error)',
      labelNames: ['tool', 'outcome'] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'brain_mcp_tool_duration_seconds',
      help: 'MCP tool call duration by tool and outcome',
      labelNames: ['tool', 'outcome'] as const,
      buckets: HTTP_DURATION_BUCKETS,
      registers: [registry],
    }),
  });
}
