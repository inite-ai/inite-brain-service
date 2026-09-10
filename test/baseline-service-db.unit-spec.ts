/**
 * BaselineService keeps eval baselines in the system database
 * (admin_baseline, 0140) instead of a cwd-relative var/ directory, so a
 * baseline saved on one replica is listed and diffed on every other one
 * and nothing is written to the (possibly read-only) root filesystem.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BaselineService } from '../src/admin/baseline.service';
import type { ScenarioRunOutcome } from '../src/admin/scenario-runner.service';
import type { SurrealService } from '../src/db/surreal.service';

interface StoredRow {
  name: string;
  savedAt: Date;
  scenarios: number;
  meanRecallAt1: number;
  outcomes: string;
}

/** In-memory stand-in for the system DB: one row per name, like the UNIQUE index. */
function fakeSurreal(): { surreal: SurrealService; rows: Map<string, StoredRow> } {
  const rows = new Map<string, StoredRow>();
  const db = {
    query: async (sql: string, vars: Record<string, unknown> = {}) => {
      if (sql.includes('UPSERT')) {
        rows.set(vars.name as string, {
          name: vars.name as string,
          savedAt: vars.savedAt as Date,
          scenarios: vars.scenarios as number,
          meanRecallAt1: vars.meanRecallAt1 as number,
          outcomes: vars.outcomes as string,
        });
        return [[]];
      }
      if (sql.includes('WHERE name = $name')) {
        const row = rows.get(vars.name as string);
        return [row ? [row] : []];
      }
      return [[...rows.values()].sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime())];
    },
  };
  const surreal = { withAdminDb: async (fn: (d: any) => Promise<any>) => fn(db) } as any;
  return { surreal, rows };
}

function outcome(scenarioId: string, recallAt1: number, recallAt5 = 1): ScenarioRunOutcome {
  return { scenarioId, metrics: { recallAt1, recallAt5 } } as unknown as ScenarioRunOutcome;
}

describe('BaselineService — system-DB backed', () => {
  it('round-trips save → list → load → diff through the admin database', async () => {
    const { surreal, rows } = fakeSurreal();
    const svc = new BaselineService(surreal);

    const saved = await svc.save('2026-09-10 v1', [outcome('s1', 0.9), outcome('s2', 0.5)]);
    expect(saved).toMatchObject({ name: '2026-09-10_v1', scenarios: 2, meanRecallAt1: 0.7 });
    expect(rows.has('2026-09-10_v1')).toBe(true);

    const listed = await svc.list();
    expect(listed).toEqual([saved]);

    const loaded = await svc.load('2026-09-10 v1');
    expect(loaded.outcomes.map((o) => o.scenarioId)).toEqual(['s1', 's2']);

    const diff = await svc.diff('2026-09-10_v1', [outcome('s1', 0.8), outcome('s2', 0.6, 1)]);
    expect(diff.baseline).toBe('2026-09-10_v1');
    expect(diff.entries).toEqual([
      expect.objectContaining({ scenarioId: 's1', metric: 'recallAt1', verdict: 'regression' }),
      expect.objectContaining({ scenarioId: 's1', metric: 'recallAt5', verdict: 'stable' }),
      expect.objectContaining({ scenarioId: 's2', metric: 'recallAt1', verdict: 'improved' }),
      expect.objectContaining({ scenarioId: 's2', metric: 'recallAt5', verdict: 'stable' }),
    ]);
  });

  it('saving the same name again replaces the baseline (one row per name)', async () => {
    const { surreal, rows } = fakeSurreal();
    const svc = new BaselineService(surreal);
    await svc.save('nightly', [outcome('s1', 0.2)]);
    await svc.save('nightly', [outcome('s1', 0.9), outcome('s2', 0.9)]);
    expect(rows.size).toBe(1);
    expect((await svc.list())[0]).toMatchObject({ scenarios: 2, meanRecallAt1: 0.9 });
  });

  it('lists newest first with ISO savedAt strings', async () => {
    const { surreal, rows } = fakeSurreal();
    const svc = new BaselineService(surreal);
    await svc.save('old', [outcome('s1', 0.1)]);
    rows.get('old')!.savedAt = new Date('2026-01-01T00:00:00.000Z');
    await svc.save('new', [outcome('s1', 0.1)]);
    const names = (await svc.list()).map((b) => b.name);
    expect(names).toEqual(['new', 'old']);
    expect((await svc.list())[1]!.savedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('404s on an unknown baseline and 400s on a name with nothing safe in it', async () => {
    const { surreal } = fakeSurreal();
    const svc = new BaselineService(surreal);
    await expect(svc.load('missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.save('///', [outcome('s1', 1)])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('touches no filesystem and reads no directory env var', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'admin', 'baseline.service.ts'), 'utf8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('BRAIN_BASELINES_DIR');
  });
});
