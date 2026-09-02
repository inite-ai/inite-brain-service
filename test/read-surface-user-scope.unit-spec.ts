import { ForbiddenException } from '@nestjs/common';
import { EntitiesService } from '../src/entities/entities.service';
import { FactsService } from '../src/facts/facts.service';
import { runWithRequestContext } from '../src/common/request-context';
import type { BrainScope } from '../src/auth/api-key.types';

/**
 * READ_SURFACE_USER_SCOPE — the per-user read fence on the two surfaces
 * that predate migration 0055 and hardcoded `userId IS NONE`:
 * EntitiesService.getTimeline and FactsService.listCompeting.
 *
 * Pins, at the query-builder seam:
 *  - flag OFF → the WHERE clause is BYTE-IDENTICAL to the historical
 *    one (`userId IS NONE`, same position), even when a userId is
 *    passed — and no new 403 path exists;
 *  - flag ON + userId → the fence widens to the search-lane union
 *    `(userId IS NONE OR userId = $scopeUserId)` with the id bound;
 *  - flag ON without a userId → historical clause (fail-closed);
 *  - flag ON + user-bound token → pinUserScope applies (mismatch 403,
 *    omitted userId defaults to the token's end-user).
 */
describe('READ_SURFACE_USER_SCOPE read fence', () => {
  const scopes: BrainScope[] = ['brain:read'];
  type Captured = { sql: string; params: Record<string, unknown> };

  afterEach(() => {
    delete process.env.READ_SURFACE_USER_SCOPE;
  });

  // ── EntitiesService.getTimeline ───────────────────────────────────
  function makeEntities() {
    const captured: Captured[] = [];
    const db = {
      query: async (sql: string, params: Record<string, unknown>) => {
        captured.push({ sql, params });
        return [[]];
      },
    };
    const surreal = {
      withScopedCompany: jest.fn(
        async (_companyId: string, _scopes: BrainScope[], fn: (db: unknown) => Promise<unknown>) =>
          fn(db),
      ),
    } as never;
    const svc = new EntitiesService(surreal, undefined as never);
    return { svc, captured };
  }

  const timeline = (
    svc: EntitiesService,
    userId?: string,
  ): Promise<{ entityId: string; events: unknown[] }> =>
    svc.getTimeline({
      companyId: 'co_x',
      entityIdRaw: 'e1',
      sinceRaw: undefined,
      untilRaw: undefined,
      userId,
      scopes,
    });

  it('timeline, flag off: historical clause byte-identical, userId ignored', async () => {
    const { svc, captured } = makeEntities();
    await timeline(svc, 'user-42');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain(
      `entityId = type::record('knowledge_entity', $rid) AND userId IS NONE`,
    );
    expect(captured[0]!.sql).not.toContain('$scopeUserId');
    expect(captured[0]!.params).not.toHaveProperty('scopeUserId');
  });

  it('timeline, flag on + userId: union clause with the id bound', async () => {
    process.env.READ_SURFACE_USER_SCOPE = '1';
    const { svc, captured } = makeEntities();
    await timeline(svc, 'user-42');
    expect(captured[0]!.sql).toContain(
      `entityId = type::record('knowledge_entity', $rid) AND (userId IS NONE OR userId = $scopeUserId)`,
    );
    expect(captured[0]!.params.scopeUserId).toBe('user-42');
  });

  it('timeline, flag on without userId: fail-closed historical clause', async () => {
    process.env.READ_SURFACE_USER_SCOPE = '1';
    const { svc, captured } = makeEntities();
    await timeline(svc);
    expect(captured[0]!.sql).toContain('AND userId IS NONE');
    expect(captured[0]!.sql).not.toContain('$scopeUserId');
  });

  it('timeline, flag on + user-bound token: pin fences the asserted id', async () => {
    process.env.READ_SURFACE_USER_SCOPE = '1';
    await runWithRequestContext({ correlationId: 't', authUserId: 'user-42' }, async () => {
      // Mismatching assertion → 403 (another user's slice).
      const { svc } = makeEntities();
      await expect(timeline(svc, 'user-OTHER')).rejects.toThrow(ForbiddenException);
      // Omitted userId defaults to the token's end-user.
      const second = makeEntities();
      await timeline(second.svc);
      expect(second.captured[0]!.params.scopeUserId).toBe('user-42');
    });
  });

  it('timeline, flag off + user-bound token mismatch: no new 403 path', async () => {
    await runWithRequestContext({ correlationId: 't', authUserId: 'user-42' }, async () => {
      const { svc, captured } = makeEntities();
      await timeline(svc, 'user-OTHER'); // ignored, not rejected
      expect(captured[0]!.sql).toContain('AND userId IS NONE');
    });
  });

  // ── FactsService.listCompeting ────────────────────────────────────
  function makeFacts() {
    const captured: Captured[] = [];
    const db = {
      query: async (sql: string, params: Record<string, unknown>) => {
        captured.push({ sql, params });
        return [[]];
      },
    };
    const surreal = {
      withCompany: jest.fn(async (_companyId: string, fn: (db: unknown) => Promise<unknown>) =>
        fn(db),
      ),
      withScopedCompany: jest.fn(
        async (
          _companyId: string,
          _scopes: readonly string[],
          fn: (db: unknown) => Promise<unknown>,
        ) => fn(db),
      ),
    } as never;
    const svc = new FactsService(surreal, undefined as never);
    return { svc, captured };
  }

  it('competing, flag off: historical clause byte-identical, userId ignored', async () => {
    const { svc, captured } = makeFacts();
    await svc.listCompeting('co_x', 'e1', { userId: 'user-42' });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain(`status = 'competing' AND userId IS NONE`);
    expect(captured[0]!.sql).not.toContain('$scopeUserId');
    expect(captured[0]!.params).not.toHaveProperty('scopeUserId');
  });

  it('competing, flag on + userId: union clause with the id bound', async () => {
    process.env.READ_SURFACE_USER_SCOPE = '1';
    const { svc, captured } = makeFacts();
    await svc.listCompeting('co_x', 'e1', { userId: 'user-42' });
    expect(captured[0]!.sql).toContain(
      `status = 'competing' AND (userId IS NONE OR userId = $scopeUserId)`,
    );
    expect(captured[0]!.params.scopeUserId).toBe('user-42');
  });

  it('competing, flag on without userId: fail-closed historical clause', async () => {
    process.env.READ_SURFACE_USER_SCOPE = '1';
    const { svc, captured } = makeFacts();
    await svc.listCompeting('co_x', 'e1');
    expect(captured[0]!.sql).toContain(`status = 'competing' AND userId IS NONE`);
  });

  it('competing, flag on + user-bound token: pin fences the asserted id', async () => {
    process.env.READ_SURFACE_USER_SCOPE = '1';
    await runWithRequestContext({ correlationId: 't', authUserId: 'user-42' }, async () => {
      const { svc } = makeFacts();
      await expect(svc.listCompeting('co_x', 'e1', { userId: 'user-OTHER' })).rejects.toThrow(
        ForbiddenException,
      );
      const second = makeFacts();
      await second.svc.listCompeting('co_x', 'e1');
      expect(second.captured[0]!.params.scopeUserId).toBe('user-42');
    });
  });
});
