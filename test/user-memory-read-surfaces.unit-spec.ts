import { ForbiddenException } from '@nestjs/common';
import { DateTime } from 'surrealdb';
import { EntitiesService } from '../src/entities/entities.service';
import { MemoryDiffService } from '../src/diff/memory-diff.service';
import { SummarizeEntityService } from '../src/summarize-entity/summarize-entity.service';
import { runWithRequestContext } from '../src/common/request-context';
import type { BrainScope } from '../src/auth/api-key.types';

/**
 * Dogfooding production over MCP with a user-bound key: every fact the
 * key wrote carried its user, and three read surfaces still fenced
 * `userId IS NONE`. get_entity_profile returned the entity with zero
 * facts, `why` answered found:0 for anchors `recall_decisions` found,
 * and memory_diff listed the new entities and not one created or
 * retracted fact — with every createdAt as "", because the driver's
 * DateTime was not a Date.
 *
 * These surfaces now read like the timeline: tenant-global plus the
 * pinned user's own rows — never a third user's, and never personal rows
 * for a caller that named no user.
 */
const scopes: BrainScope[] = ['brain:read'];
type Captured = { sql: string; params: Record<string, unknown> };
const asUser = <T>(fn: () => Promise<T>) =>
  runWithRequestContext({ correlationId: 't', authUserId: 'user-42' }, fn);

function fakeDb(rowsFor: (sql: string) => unknown[] = () => []) {
  const captured: Captured[] = [];
  const db = {
    query: async (sql: string, params: Record<string, unknown>) => {
      captured.push({ sql, params });
      return sql.split(';').map((one) => rowsFor(one));
    },
  };
  const surreal = {
    withScopedCompany: async (_c: string, _s: unknown, fn: (db: unknown) => Promise<unknown>) =>
      fn(db),
  } as never;
  return { surreal, captured };
}

const ENTITY = { id: 'knowledge_entity:e1', type: 'project', canonicalName: 'brain' };
const entityRows = (sql: string) =>
  sql.includes("FROM type::record('knowledge_entity'") ? [ENTITY] : [];
const factQueries = (c: Captured[]) => c.filter((q) => q.sql.includes('FROM knowledge_fact'));

afterEach(() => {
  delete process.env.READ_SURFACE_USER_SCOPE;
});

describe('a user-bound token reads its own memory on every entity surface', () => {
  it('the profile includes the token user’s facts, and only theirs', async () => {
    const { surreal, captured } = fakeDb(entityRows);
    const svc = new EntitiesService(surreal, undefined as never);
    await asUser(() =>
      svc.getProfile({ companyId: 'co', entityIdRaw: 'e1', asOfRaw: undefined, scopes }),
    );
    const [facts] = factQueries(captured);
    expect(facts!.sql).toContain('(userId IS NONE OR userId = $scopeUserId)');
    expect(facts!.params.scopeUserId).toBe('user-42');
  });

  it('an M2M caller naming no user still reads tenant-global only', async () => {
    const { surreal, captured } = fakeDb(entityRows);
    const svc = new EntitiesService(surreal, undefined as never);
    await svc.getProfile({ companyId: 'co', entityIdRaw: 'e1', asOfRaw: undefined, scopes });
    const [facts] = factQueries(captured);
    expect(facts!.sql).toContain('AND userId IS NONE');
    expect(facts!.params).not.toHaveProperty('scopeUserId');
  });

  it('a token cannot read another user’s profile slice', async () => {
    const { surreal } = fakeDb(entityRows);
    const svc = new EntitiesService(surreal, undefined as never);
    await asUser(async () => {
      await expect(
        svc.getProfile({
          companyId: 'co',
          entityIdRaw: 'e1',
          asOfRaw: undefined,
          userId: 'user-OTHER',
          scopes,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('`why` resolves the anchor and reads the same slice', async () => {
    const { surreal, captured } = fakeDb((sql) =>
      sql.includes('FROM entity_external_ref') ? ['knowledge_entity:e1'] : entityRows(sql),
    );
    const svc = new EntitiesService(surreal, undefined as never);
    await asUser(() =>
      svc.getProfileByExternalRef({
        companyId: 'co',
        vertical: 'code',
        id: 'src/a.ts',
        asOfRaw: undefined,
        scopes,
      }),
    );
    expect(factQueries(captured)[0]!.params.scopeUserId).toBe('user-42');
  });

  it('the flag cleared restores the tenant-global fence', async () => {
    process.env.READ_SURFACE_USER_SCOPE = '0';
    const { surreal, captured } = fakeDb(entityRows);
    const svc = new EntitiesService(surreal, undefined as never);
    await asUser(() =>
      svc.getProfile({ companyId: 'co', entityIdRaw: 'e1', asOfRaw: undefined, scopes }),
    );
    expect(factQueries(captured)[0]!.sql).toContain('AND userId IS NONE');
  });
});

describe('memory_diff for a user-bound token', () => {
  const at = new DateTime(new Date('2026-09-24T17:00:00.000Z'));
  const window = { from: '2026-09-24T00:00:00Z', to: '2026-09-25T00:00:00Z' };

  it('counts the facts the user wrote and dates everything', async () => {
    const { surreal, captured } = fakeDb((sql) => {
      if (sql.includes('WHERE recordedAt >= $from'))
        return [
          {
            id: 'knowledge_fact:f1',
            entityId: 'knowledge_entity:e1',
            predicate: 'model',
            object: 'gpt-6-luna',
            confidence: 0.9,
            validFrom: at,
            recordedAt: at,
          },
        ];
      if (sql.includes('FROM knowledge_entity')) return [{ ...ENTITY, createdAt: at }];
      return [];
    });
    const out = await asUser(() => new MemoryDiffService(surreal).diff('co', window, scopes));
    const created = captured.find((q) => q.sql.includes('WHERE recordedAt >= $from'))!;
    expect(created.sql).toContain('(userId IS NONE OR userId = $scopeUserId)');
    expect(created.params.scopeUserId).toBe('user-42');
    expect(out.createdFacts).toHaveLength(1);
    expect(out.createdFacts[0]!.recordedAt).toBe('2026-09-24T17:00:00.000Z');
    expect(out.newEntities[0]!.createdAt).toBe('2026-09-24T17:00:00.000Z');
  });

  it('rejects another user’s window', async () => {
    const { surreal } = fakeDb();
    await asUser(async () => {
      await expect(
        new MemoryDiffService(surreal).diff('co', { ...window, userId: 'user-OTHER' }, scopes),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

describe('summarize_entity never serves one user’s summary to another', () => {
  it('keys its cache by the resolved user', async () => {
    const profiles: Array<string | undefined> = [];
    const entities = {
      freshnessWatermark: async () => ({ maxRecordedAt: null, maxValidFrom: null }),
      getProfile: async (o: { userId?: string }) => {
        profiles.push(o.userId);
        return {
          entityId: 'knowledge_entity:e1',
          canonicalName: 'brain',
          type: 'project',
          externalRefs: {},
          facts: [],
        };
      },
    } as unknown as EntitiesService;
    const svc = new SummarizeEntityService(entities);
    await asUser(() => svc.summarize('co', { entityId: 'e1' }, scopes));
    await runWithRequestContext({ correlationId: 't', authUserId: 'user-7' }, () =>
      svc.summarize('co', { entityId: 'e1' }, scopes),
    );
    await svc.summarize('co', { entityId: 'e1' }, scopes);
    expect(profiles).toEqual(['user-42', 'user-7', undefined]);
  });
});
