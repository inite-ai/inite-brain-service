import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Registry } from 'prom-client';
import {
  HTTP_DURATION_BUCKETS,
  httpMetrics,
  httpMetricsMiddleware,
  mcpToolMetrics,
  routeOf,
  statusClass,
} from '../src/metrics/http-metrics';

function fakeRes(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    writableFinished: boolean;
  };
  res.statusCode = statusCode;
  res.writableFinished = false;
  return res;
}

async function sample(registry: Registry, name: string) {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  return metric?.values ?? [];
}

describe('HTTP RED metrics', () => {
  it('labels by the matched route template, never the raw path', () => {
    expect(routeOf({ baseUrl: '', route: { path: '/v1/facts/:id' } } as never)).toBe(
      '/v1/facts/:id',
    );
    expect(routeOf({ baseUrl: '/api', route: { path: '/x' } } as never)).toBe('/api/x');
    expect(routeOf({ baseUrl: '', route: undefined } as never)).toBe('unmatched');
  });

  it('folds status codes into classes, and an abandoned response is aborted', () => {
    expect(statusClass(201, true)).toBe('2xx');
    expect(statusClass(429, true)).toBe('4xx');
    expect(statusClass(503, true)).toBe('5xx');
    expect(statusClass(200, false)).toBe('aborted');
  });

  it('records one observation per request on finish, even when close follows', async () => {
    const registry = new Registry();
    const m = httpMetrics(registry);
    const req = { method: 'POST', baseUrl: '', route: { path: '/v1/search' } };
    const res = fakeRes(503);
    httpMetricsMiddleware(m)(req as never, res as never, () => undefined);
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    const counted = await sample(registry, 'brain_http_requests_total');
    expect(counted).toEqual([
      expect.objectContaining({
        value: 1,
        labels: { method: 'POST', route: '/v1/search', status_class: '5xx' },
      }),
    ]);
  });

  it('a request a guard rejects before routing still counts, as unmatched', async () => {
    const registry = new Registry();
    const m = httpMetrics(registry);
    const res = fakeRes(401);
    httpMetricsMiddleware(m)(
      { method: 'GET', baseUrl: '' } as never,
      res as never,
      () => undefined,
    );
    res.writableFinished = true;
    res.emit('finish');
    const counted = await sample(registry, 'brain_http_requests_total');
    expect(counted[0]?.labels).toEqual({ method: 'GET', route: 'unmatched', status_class: '4xx' });
  });

  it('declares the tool metrics with the same buckets', async () => {
    const registry = new Registry();
    const t = mcpToolMetrics(registry);
    t.duration.observe({ tool: 'synthesize', outcome: 'ok' }, 3);
    const buckets = (await sample(registry, 'brain_mcp_tool_duration_seconds'))
      .filter(
        (v) =>
          (v as { metricName?: string }).metricName === 'brain_mcp_tool_duration_seconds_bucket',
      )
      .map((v) => v.labels.le);
    expect(buckets).toEqual([...HTTP_DURATION_BUCKETS, '+Inf']);
  });
});

/**
 * The SLO rules read series by name and by bucket edge; a renamed metric or
 * a moved bucket turns an alert into permanent NoData (which these rules
 * read as OK). Pin both to the code.
 */
describe('SLO rules match the exported metrics', () => {
  const rules = readFileSync(
    join(__dirname, '..', 'monitoring', 'grafana', 'provisioning', 'alerting', 'rules.yaml'),
    'utf8',
  );
  const slo = rules.slice(rules.indexOf('# ── SLOs'));

  it('every brain_ series an SLO rule reads is exported', async () => {
    const registry = new Registry();
    httpMetrics(registry);
    mcpToolMetrics(registry);
    const exported = new Set(
      (await registry.getMetricsAsJSON()).flatMap((m) =>
        String(m.type) === 'histogram'
          ? [`${m.name}_bucket`, `${m.name}_count`, `${m.name}_sum`]
          : [m.name],
      ),
    );
    const read = new Set(slo.match(/brain_[a-z_]+/g) ?? []);
    expect(read.size).toBeGreaterThan(0);
    for (const name of read) expect(exported).toContain(name);
  });

  it('the latency threshold sits on a bucket edge', () => {
    for (const le of slo.match(/le="([0-9.]+)"/g) ?? []) {
      expect(HTTP_DURATION_BUCKETS).toContain(Number(le.slice(4, -1)));
    }
  });

  it('documents every SLO alert in docs/slo.md', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'slo.md'), 'utf8');
    for (const title of slo.match(/title: (\w+)/g) ?? []) {
      expect(doc).toContain(title.slice('title: '.length));
    }
  });
});
