/**
 * MriService persists its latest snapshot as `mri_snapshot:latest` in
 * the system database (0140) — visible from every replica, no
 * cwd-relative var/ write — and a failed write never fails the report.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MriService } from '../src/mri/mri.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { MriReport } from '../src/mri/mri.types';

function fakeMetrics(): MetricsService {
  return { registry: { getMetricsAsJSON: async () => [] } } as unknown as MetricsService;
}

function fakeSurreal(opts: { fail?: boolean } = {}) {
  const writes: Array<{ sql: string; vars: Record<string, unknown> }> = [];
  const surreal = {
    withAdminDb: async (fn: (db: any) => Promise<any>) => {
      if (opts.fail) throw new Error('system db unreachable');
      return fn({
        query: async (sql: string, vars: Record<string, unknown>) => {
          writes.push({ sql, vars });
          return [[]];
        },
      });
    },
  } as unknown as SurrealService;
  return { surreal, writes };
}

describe('MriService — snapshot in the system database', () => {
  it('upserts mri_snapshot:latest with the report it returns', async () => {
    const { surreal, writes } = fakeSurreal();
    const report = await new MriService(fakeMetrics(), surreal).generate({
      now: new Date('2026-09-10T00:00:00.000Z'),
      plausibilityCheckEnabled: false,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('UPSERT mri_snapshot:latest');
    expect(writes[0]!.vars.generatedAt).toEqual(new Date(report.generatedAt));
    const stored = JSON.parse(writes[0]!.vars.report as string) as MriReport;
    expect(stored.generatedAt).toBe(report.generatedAt);
    expect(Object.keys(stored.dimensions)).toEqual(Object.keys(report.dimensions));
  });

  it('a failed snapshot write never fails the report', async () => {
    const { surreal } = fakeSurreal({ fail: true });
    const report = await new MriService(fakeMetrics(), surreal).generate({
      plausibilityCheckEnabled: false,
    });
    expect(typeof report.generatedAt).toBe('string');
  });

  it('runs without a database (unit fixtures) and never touches the filesystem', async () => {
    const report = await new MriService(fakeMetrics()).generate({
      plausibilityCheckEnabled: false,
    });
    expect(typeof report.generatedAt).toBe('string');
    const src = readFileSync(join(__dirname, '..', 'src', 'mri', 'mri.service.ts'), 'utf8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain("'var'");
  });
});
