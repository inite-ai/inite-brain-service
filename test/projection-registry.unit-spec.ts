import { ProjectionRegistryService } from '../src/episodes/projection-registry.service';
import { ProjectionsController } from '../src/admin/projections.controller';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { SurrealService } from '../src/db/surreal.service';
import type { WindowDeriverService } from '../src/admin/window-deriver.service';
import type { ReadPinService } from '../src/episodes/read-pin.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

function makeRegistry(rowsPerQuery: unknown[][] = [[]]): {
  svc: ProjectionRegistryService;
  queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }> = [];
  const surreal = {
    withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params?: Record<string, unknown>) => {
          queries.push({ sql, params });
          return [rowsPerQuery[queries.length - 1] ?? []];
        },
      }),
  } as unknown as SurrealService;
  return { svc: new ProjectionRegistryService(surreal), queries };
}

describe('ProjectionRegistryService (driver surface 3)', () => {
  it('begin upserts the array-id row into building', async () => {
    const { svc, queries } = makeRegistry();
    await svc.begin({
      companyId: 'co_x',
      name: 'facts',
      version: 'wd-v3',
      builder: 'window-deriver',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('UPSERT projection:[$name, $version]');
    expect(queries[0]!.sql).toContain(`status = 'building'`);
    expect(queries[0]!.params).toMatchObject({ name: 'facts', version: 'wd-v3' });
  });

  it('complete(live) demotes the previous live version first', async () => {
    const { svc, queries } = makeRegistry();
    await svc.complete({
      companyId: 'co_x',
      name: 'facts',
      version: 'wd-v3',
      live: true,
      stats: { propositions: 12 },
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain(`SET status = 'residual'`);
    expect(queries[0]!.sql).toContain(`status = 'live'`);
    expect(queries[1]!.params).toMatchObject({ status: 'live' });
  });

  it('complete(non-live) writes built without touching other rows', async () => {
    const { svc, queries } = makeRegistry();
    await svc.complete({
      companyId: 'co_x',
      name: 'facts',
      version: 'wd-v3',
      live: false,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.params).toMatchObject({ status: 'built' });
  });

  it('dropVersions deletes only the reaped versions, skips empty input', async () => {
    const { svc, queries } = makeRegistry();
    await svc.dropVersions({ companyId: 'co_x', name: 'facts', versions: [] });
    expect(queries).toHaveLength(0);
    await svc.dropVersions({
      companyId: 'co_x',
      name: 'facts',
      versions: ['wd-old'],
    });
    expect(queries[0]!.sql).toContain('DELETE projection');
    expect(queries[0]!.params).toMatchObject({ versions: ['wd-old'] });
  });

  it('degrades to a warning when the DB is down (registry must not fail builders)', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const svc = new ProjectionRegistryService(surreal);
    await expect(
      svc.begin({ companyId: 'co_x', name: 'facts', version: 'v', builder: 'b' }),
    ).resolves.toBeUndefined();
    expect(await svc.list('co_x')).toEqual([]);
  });
});

describe('ProjectionsController gating', () => {
  const saved = process.env.PROJECTIONS_API_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.PROJECTIONS_API_ENABLED;
    else process.env.PROJECTIONS_API_ENABLED = saved;
  });

  const req = {
    brainAuth: { companyId: 'co_x' },
  } as unknown as AuthenticatedRequest;

  function makeController(): ProjectionsController {
    const registry = {
      list: async () => [],
    } as unknown as ProjectionRegistryService;
    const deriver = {
      run: async () => ({
        conversations: 1,
        sessions: 1,
        propositions: 1,
        unresolvedSubjects: 0,
        skipped: [],
      }),
    } as unknown as WindowDeriverService;
    const readPin = {
      resolve: async () => 'wd-v2',
      invalidate: () => undefined,
    } as unknown as ReadPinService;
    return new ProjectionsController(registry, deriver, readPin);
  }

  it('flag off → 404 on both routes', async () => {
    delete process.env.PROJECTIONS_API_ENABLED;
    const c = makeController();
    await expect(c.list(req)).rejects.toThrow(NotFoundException);
    await expect(c.rebuild(req, 'facts', {})).rejects.toThrow(NotFoundException);
  });

  it('flag on → list returns rows + read pin; unknown name → 400', async () => {
    process.env.PROJECTIONS_API_ENABLED = '1';
    const c = makeController();
    const out = await c.list(req);
    expect(out.projections).toEqual([]);
    // The pin comes from the per-tenant resolver, not the pod's env.
    expect(out.readPin).toBe('wd-v2');
    await expect(c.rebuild(req, 'segments', {})).rejects.toThrow(BadRequestException);
    await expect(c.rebuild(req, 'facts', { version: 'BAD VERSION' })).rejects.toThrow(
      BadRequestException,
    );
    const run = await c.rebuild(req, 'facts', { version: 'wd-v3' });
    expect(run.conversations).toBe(1);
  });
});
