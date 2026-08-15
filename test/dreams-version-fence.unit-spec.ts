import type { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { DreamsDedupService } from '../src/dreams/dedup.service';
import { DreamsResolverService } from '../src/dreams/resolver.service';
import { DreamsCorroborateService } from '../src/dreams/corroborate.service';
import { derivedVersionFence } from '../src/episodes/read-pin.service';
import type { EntityJudgeService } from '../src/ai/entity-judge.service';

/**
 * Audit W2 #10 (dreams port of the compaction fence): dreams legs were
 * version-BLIND — dedup drew identity edges off residual worlds' name
 * facts, resolve treated the same fact re-derived into three worlds as
 * a 3-way disagreement, corroborate mutated fact status in worlds the
 * pinned reader never queries. Every candidate SELECT now carries the
 * derived-world fence.
 */
function recordingDb(): {
  db: Surreal;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      return [[]];
    },
  } as unknown as Surreal;
  return { db, queries };
}

function config(flags: Record<string, string>): ConfigService {
  return {
    get: (k: string, d?: string) => flags[k] ?? d,
    getOrThrow: (k: string) => flags[k] ?? 'x',
  } as unknown as ConfigService;
}

describe('derivedVersionFence', () => {
  it('pins the versioned world', () => {
    expect(derivedVersionFence('wd-v3')).toEqual({
      clause: 'AND derivedVersion = $derivedVersion',
      params: { derivedVersion: 'wd-v3' },
    });
  });

  it('pins the legacy namespace when no world is live', () => {
    expect(derivedVersionFence(null)).toEqual({
      clause: 'AND derivedVersion IS NONE',
      params: {},
    });
  });
});

describe('dreams legs stay inside the tenant live world (W2)', () => {
  it('dedup seed query is fenced to the pin', async () => {
    const { db, queries } = recordingDb();
    const svc = new DreamsDedupService(
      config({ DREAMS_DEDUP_ENABLED: '1', OPENAI_API_KEY: 'sk' }),
      { isAvailable: () => true } as unknown as EntityJudgeService,
    );
    await svc.run(db, 'wd-v3');
    const seed = queries.find((q) => q.sql.includes("predicate = 'name'"));
    expect(seed?.sql).toContain('AND derivedVersion = $derivedVersion');
    expect(seed?.params?.derivedVersion).toBe('wd-v3');
  });

  it('dedup legacy tenant is fenced to the NONE namespace', async () => {
    const { db, queries } = recordingDb();
    const svc = new DreamsDedupService(
      config({ DREAMS_DEDUP_ENABLED: '1', OPENAI_API_KEY: 'sk' }),
      { isAvailable: () => true } as unknown as EntityJudgeService,
    );
    await svc.run(db, null);
    const seed = queries.find((q) => q.sql.includes("predicate = 'name'"));
    expect(seed?.sql).toContain('AND derivedVersion IS NONE');
    expect(seed?.params?.derivedVersion).toBeUndefined();
  });

  it('resolver competing-pair query is fenced to the pin', async () => {
    const { db, queries } = recordingDb();
    const svc = new DreamsResolverService(
      config({ DREAMS_RESOLVE_ENABLED: '1', OPENAI_API_KEY: 'sk' }),
    );
    await svc.run(db, 'wd-v3');
    const find = queries.find((q) => q.sql.includes("status = 'competing'"));
    expect(find?.sql).toContain('AND derivedVersion = $derivedVersion');
    expect(find?.params?.derivedVersion).toBe('wd-v3');
  });

  it('corroborate group query is fenced to the pin', async () => {
    const { db, queries } = recordingDb();
    const svc = new DreamsCorroborateService(
      config({ DREAMS_CORROBORATE_ENABLED: '1', OPENAI_API_KEY: 'sk' }),
    );
    await svc.run(db, 'wd-v3');
    const groups = queries.find((q) =>
      q.sql.includes('GROUP BY entityId, canonPredicate'),
    );
    expect(groups?.sql).toContain('AND derivedVersion = $derivedVersion');
    expect(groups?.params?.derivedVersion).toBe('wd-v3');
  });
});
