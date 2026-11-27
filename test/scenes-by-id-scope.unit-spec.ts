/**
 * GET /v1/scenes/:id applies the scope-tag fence the list applies.
 * Before, a scene id read past it: a circle's or a group's scene was
 * served by id to a credential outside that circle or group.
 */
import { ScenesService } from '../src/scenes/scenes.service';
import type { SurrealService } from '../src/db/surreal.service';
import { runWithRequestContext } from '../src/common/request-context';

function harness() {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const surreal = {
    withScopedCompany: async (_c: string, _s: unknown, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params: Record<string, unknown>) => {
          queries.push({ sql, params });
          return [
            [
              {
                id: 'memory_episode:s1',
                userId: 'u1',
                userIds: ['u1'],
                gist: 'g',
                occurredFrom: '2026-01-01T00:00:00Z',
                occurredTo: '2026-01-01T01:00:00Z',
              },
            ],
          ];
        },
      }),
  } as unknown as SurrealService;
  return { scenes: new ScenesService(surreal), queries };
}

const read = (scenes: ScenesService) =>
  scenes.getScene({ companyId: 'co_t', sceneId: 's1', scopes: ['brain:read'] });

describe('scene by id: scope-tag fence', () => {
  it('a user-bound token reads by id under the scope fence', async () => {
    const { scenes, queries } = harness();
    await runWithRequestContext({ correlationId: 'c', authUserId: 'u1' }, () => read(scenes));
    expect(queries[0]!.sql).toContain('scope = []');
    expect(queries[0]!.params.principalScopeTag).toBe('user:u1');
  });

  it('a credential acting in a circle reads only global or its own circle by id', async () => {
    const { scenes, queries } = harness();
    await runWithRequestContext({ correlationId: 'c', actingCircle: 'family' }, () =>
      read(scenes).catch(() => undefined),
    );
    expect(queries[0]!.sql).toContain('scope ALLINSIDE $principalScopeTag');
    expect(queries[0]!.params.principalScopeTag).toEqual(['circle:family']);
  });

  it('keeps the PII gate', async () => {
    const { scenes, queries } = harness();
    await read(scenes).catch(() => undefined);
    expect(queries[0]!.sql).toContain('piiClass IS NONE');
  });
});
