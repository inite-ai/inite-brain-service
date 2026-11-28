/**
 * Pure-verdict unit coverage of the belief read fence (the factVisible
 * idiom): beliefVisible is the ONE visibility implementation both
 * GET /v1/beliefs/:id and the list's JS re-filter apply — pinned here so
 * the fail-closed semantics can never drift silently.
 */
import {
  beliefVisible,
  BeliefsService,
  BELIEFS_LIST_DEFAULT,
  BELIEFS_LIST_MAX,
} from '../src/beliefs/beliefs.service';
import type { SurrealService } from '../src/db/surreal.service';
import { runWithRequestContext } from '../src/common/request-context';

describe('beliefVisible (fail-closed single-user fence)', () => {
  it('M2M (no pinned user) sees any well-stamped belief', () => {
    expect(beliefVisible({ userId: 'u1' }, undefined)).toBe(true);
    expect(beliefVisible({ userId: 'u2' }, undefined)).toBe(true);
  });

  it('a user-bound token sees only its OWN beliefs', () => {
    expect(beliefVisible({ userId: 'u1' }, 'u1')).toBe(true);
    expect(beliefVisible({ userId: 'u2' }, 'u1')).toBe(false);
  });

  it('an out-of-contract stamp is invisible to EVERYONE — M2M included', () => {
    // The promotion never writes these (#387 fence); if such a row ever
    // exists it must serve to no caller, fail-closed.
    for (const userId of ['', undefined, null, 42, ['u1']]) {
      expect(beliefVisible({ userId }, undefined)).toBe(false);
      expect(beliefVisible({ userId }, 'u1')).toBe(false);
    }
  });
});

describe('belief list caps', () => {
  it('pins the page constants the controller clamps against', () => {
    expect(BELIEFS_LIST_DEFAULT).toBe(25);
    expect(BELIEFS_LIST_MAX).toBe(100);
  });
});

describe('GET /v1/beliefs user fence (beliefs are always personal)', () => {
  function svc() {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const surreal = {
      withScopedCompany: async (_c: string, _s: unknown, fn: (db: unknown) => Promise<unknown>) =>
        fn({
          query: async (sql: string, params: Record<string, unknown>) => {
            queries.push({ sql, params });
            return [[{ id: 'semantic_belief:b1', userId: params.u, subject: 's', field: 'f' }]];
          },
        }),
    } as unknown as SurrealService;
    return { beliefs: new BeliefsService(surreal), queries };
  }
  const base = {
    companyId: 'co_t',
    scopes: ['brain:read'] as const,
    status: 'active' as const,
    limit: 25,
  };

  it('an M2M request naming no user lists none and reads nothing', async () => {
    const { beliefs, queries } = svc();
    await expect(beliefs.listBeliefs({ ...base, scopes: ['brain:read'] })).resolves.toEqual({
      beliefs: [],
      found: 0,
    });
    expect(queries).toHaveLength(0);
  });

  it('an M2M request naming a user lists that user only', async () => {
    const { beliefs, queries } = svc();
    const out = await beliefs.listBeliefs({ ...base, scopes: ['brain:read'], userId: 'u1' });
    expect(out.found).toBe(1);
    expect(queries[0]!.sql).toContain('userId = $u');
    expect(queries[0]!.params.u).toBe('u1');
  });

  it('a user-bound token naming no user lists its own', async () => {
    const { beliefs, queries } = svc();
    await runWithRequestContext({ correlationId: 'c', authUserId: 'u2' }, () =>
      beliefs.listBeliefs({ ...base, scopes: ['brain:read'] }),
    );
    expect(queries[0]!.params.u).toBe('u2');
  });
});
