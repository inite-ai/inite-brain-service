/**
 * The read-only operator view over installed indexers
 * (GET /v1/admin/indexers, INDEXER_OPERATOR_VIEW_ENABLED).
 *
 * Covers: the wire contracts, the "declared descriptor or absent" rule,
 * aggregates computed from fixture ledger rows, the window/row caps, the
 * tenant fence (both the controller's resolvePlatformTenant seam and the
 * service's withCompany seam), and flag-off 404.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IndexerOperatorService } from '../src/documents/indexer-operator.service';
import { IndexerAdminController } from '../src/documents/indexer-admin.controller';
import type { IndexerRouterService } from '../src/indexers/indexer-router.service';
import type { IndexerBinding } from '../src/indexers/routing';
import type { SurrealService } from '../src/db/surreal.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';
import {
  IndexerOverviewListResponseSchema,
  IndexerRunListResponseSchema,
} from '../src/contracts/indexer/indexer-operator.schema';

const FLAG = 'INDEXER_OPERATOR_VIEW_ENABLED';
const HOUR = 3_600_000;

function binding(over: Partial<IndexerBinding> & { indexerId: string }): IndexerBinding {
  return {
    packVersion: '1.0.0',
    mode: 'dedicated',
    description: 'a pack',
    source: 'installed',
    declared: true,
    ...over,
  };
}

/** Two dedicated packs, one external pack, one pack with NO descriptor. */
const BINDINGS: IndexerBinding[] = [
  binding({ indexerId: 'legal', installedAt: new Date('2026-01-02T03:04:05.000Z') }),
  binding({
    indexerId: 'remote',
    mode: 'external',
    external: { publisher: 'acme' },
    source: 'builtin',
  }),
  binding({ indexerId: 'core', source: 'builtin', declared: false }),
];

interface FakeDb {
  query: (sql: string, vars?: Record<string, unknown>) => Promise<unknown[]>;
}

interface Recorded {
  tenants: string[];
  sql: string[];
}

/** Fixture ledger: run rows per pack + candidate tallies per run id. */
function makeService(p: {
  runs?: Record<string, Array<Record<string, unknown>>>;
  candidates?: Array<{ runId: string; status: string; n: number }>;
  bindings?: IndexerBinding[];
}): { svc: IndexerOperatorService; rec: Recorded } {
  const rec: Recorded = { tenants: [], sql: [] };
  const db: FakeDb = {
    query: async (sql, vars) => {
      rec.sql.push(sql);
      if (sql.includes('FROM indexer_run')) {
        return [p.runs?.[String(vars?.pack)] ?? []];
      }
      const ids = new Set((vars?.ids as unknown[] | undefined)?.map(String) ?? []);
      return [(p.candidates ?? []).filter((c) => ids.has(c.runId))];
    },
  };
  const surreal = {
    withCompany: async <T>(companyId: string, fn: (db: FakeDb) => Promise<T>): Promise<T> => {
      rec.tenants.push(companyId);
      return fn(db);
    },
  } as unknown as SurrealService;
  const router = {
    bindingsFor: () => Promise.resolve(p.bindings ?? BINDINGS),
  } as unknown as IndexerRouterService;
  return { svc: new IndexerOperatorService(surreal, router), rec };
}

function makeController(svc: IndexerOperatorService): IndexerAdminController {
  const apiKeys = { knownCompanyIds: () => ['co_test', 'co_other'] } as unknown as ApiKeyService;
  return new IndexerAdminController(svc, apiKeys);
}

function req(scopes: string[] = ['brain:admin']): AuthenticatedRequest {
  return { brainAuth: { companyId: 'co_test', scopes } } as unknown as AuthenticatedRequest;
}

describe('IndexerOperatorService.listIndexers()', () => {
  it('matches IndexerOverviewListResponseSchema', async () => {
    const { svc } = makeService({
      runs: {
        legal: [
          {
            id: 'indexer_run:r1',
            docId: 'source_document:d1',
            packId: 'legal',
            packVersion: '1.0.0',
            status: 'succeeded',
            external: false,
            createdAt: '2026-09-01T00:00:00.000Z',
            finishedAt: '2026-09-01T00:00:09.000Z',
            stats: { chunks: 2, entities: 5, facts: 7, relations: 1, durationMs: 9000 },
          },
        ],
      },
      candidates: [{ runId: 'indexer_run:r1', status: 'committed', n: 7 }],
    });
    const parsed = IndexerOverviewListResponseSchema.safeParse(
      await svc.listIndexers({ companyId: 'co_test' }),
    );
    if (!parsed.success) {
      throw new Error(`operator view drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('omits a pack that declared no indexer descriptor', async () => {
    const { svc } = makeService({});
    const out = await svc.listIndexers({ companyId: 'co_test' });
    expect(out.indexers.map((i) => i.packId)).toEqual(['legal', 'remote']);
  });

  it('computes run and candidate aggregates from the ledger rows', async () => {
    const { svc } = makeService({
      runs: {
        legal: [
          {
            id: 'indexer_run:r2',
            docId: 'source_document:d2',
            packId: 'legal',
            packVersion: '1.0.0',
            status: 'failed',
            createdAt: '2026-09-02T00:00:00.000Z',
            finishedAt: '2026-09-02T00:00:01.000Z',
            error: { message: 'boom' },
          },
          {
            id: 'indexer_run:r1',
            docId: 'source_document:d1',
            packId: 'legal',
            packVersion: '1.0.0',
            status: 'succeeded',
            createdAt: '2026-09-01T00:00:00.000Z',
          },
          {
            id: 'indexer_run:r0',
            docId: 'source_document:d0',
            packId: 'legal',
            packVersion: '0.9.0',
            status: 'skipped',
            createdAt: '2026-08-31T00:00:00.000Z',
          },
        ],
      },
      candidates: [
        { runId: 'indexer_run:r1', status: 'committed', n: 4 },
        { runId: 'indexer_run:r1', status: 'rejected', n: 1 },
        { runId: 'indexer_run:r2', status: 'pending', n: 2 },
        // Belongs to another indexer's run — must not land in these tallies.
        { runId: 'indexer_run:zz', status: 'committed', n: 99 },
      ],
    });
    const out = await svc.listIndexers({ companyId: 'co_test' });
    const legal = out.indexers.find((i) => i.packId === 'legal');
    expect(legal?.runs).toEqual({
      total: 3,
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 1,
      skipped: 1,
    });
    expect(legal?.candidates).toEqual({
      submitted: 7,
      pending: 2,
      committed: 4,
      merged: 0,
      duplicate: 0,
      rejected: 1,
      expired: 0,
    });
    // Newest first — the ledger query orders DESC, the view keeps it.
    expect(legal?.lastRun?.runId).toBe('indexer_run:r2');
    expect(legal?.lastRun?.error).toBe('boom');
    expect(legal?.lastRun?.candidates.pending).toBe(2);
    expect(legal?.installedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(legal?.source).toBe('installed');
    // A non-external indexer carries no publisher health.
    expect(legal?.external).toBeNull();
  });

  it('reports external publisher liveness from the claim ledger', async () => {
    const now = Date.now();
    const { svc } = makeService({
      runs: {
        remote: [
          {
            id: 'indexer_run:x2',
            docId: 'source_document:d9',
            packId: 'remote',
            packVersion: '1.0.0',
            status: 'pending',
            external: true,
            createdAt: new Date(now - 2 * HOUR).toISOString(),
          },
          {
            id: 'indexer_run:x1',
            docId: 'source_document:d8',
            packId: 'remote',
            packVersion: '1.0.0',
            status: 'pending',
            external: true,
            createdAt: new Date(now - 30 * HOUR).toISOString(),
          },
          {
            id: 'indexer_run:x0',
            docId: 'source_document:d7',
            packId: 'remote',
            packVersion: '1.0.0',
            status: 'succeeded',
            external: true,
            createdAt: new Date(now - 40 * HOUR).toISOString(),
            claimedAt: new Date(now - 3 * HOUR).toISOString(),
          },
        ],
      },
    });
    const out = await svc.listIndexers({ companyId: 'co_test' });
    const remote = out.indexers.find((i) => i.packId === 'remote');
    expect(remote?.external?.publisher).toBe('acme');
    expect(remote?.external?.pendingWork).toBe(2);
    expect(remote?.external?.oldestPendingAt).toBe(new Date(now - 30 * HOUR).toISOString());
    expect(remote?.external?.lastClaimAt).toBe(new Date(now - 3 * HOUR).toISOString());
    expect(remote?.external?.polledRecently).toBe(true);
  });

  it('reads a publisher that never claimed as not polling', async () => {
    const { svc } = makeService({
      runs: {
        remote: [
          {
            id: 'indexer_run:x1',
            docId: 'source_document:d8',
            packId: 'remote',
            packVersion: '1.0.0',
            status: 'pending',
            external: true,
            createdAt: new Date(Date.now() - 5 * HOUR).toISOString(),
          },
        ],
      },
    });
    const out = await svc.listIndexers({ companyId: 'co_test' });
    const remote = out.indexers.find((i) => i.packId === 'remote');
    expect(remote?.external?.lastClaimAt).toBeNull();
    expect(remote?.external?.polledRecently).toBe(false);
  });

  it('clamps the window and the per-indexer row cap', async () => {
    const { svc, rec } = makeService({});
    const wide = await svc.listIndexers({ companyId: 'co_test', days: 9999, runCap: 9999 });
    expect(wide.window.days).toBe(90);
    expect(wide.window.runCap).toBe(200);
    expect(rec.sql.some((s) => s.includes('LIMIT 200'))).toBe(true);

    const dflt = await svc.listIndexers({ companyId: 'co_test' });
    expect(dflt.window.days).toBe(7);
    expect(dflt.window.runCap).toBe(50);

    const junk = await svc.listIndexers({ companyId: 'co_test', days: -3, runCap: 0 });
    expect(junk.window.days).toBe(7);
    expect(junk.window.runCap).toBe(50);
  });

  it('flags a truncated indexer when the row cap bites', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `indexer_run:r${i}`,
      docId: 'source_document:d1',
      packId: 'legal',
      packVersion: '1.0.0',
      status: 'succeeded',
      createdAt: '2026-09-01T00:00:00.000Z',
    }));
    const { svc } = makeService({ runs: { legal: rows } });
    const out = await svc.listIndexers({ companyId: 'co_test', runCap: 3 });
    expect(out.indexers.find((i) => i.packId === 'legal')?.truncated).toBe(true);
    expect(out.indexers.find((i) => i.packId === 'remote')?.truncated).toBe(false);
  });

  it('reads only the requested tenant (no cross-tenant fan-out)', async () => {
    const { svc, rec } = makeService({
      runs: {
        legal: [
          {
            id: 'indexer_run:r1',
            docId: 'source_document:d1',
            packId: 'legal',
            packVersion: '1.0.0',
            status: 'succeeded',
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
      candidates: [{ runId: 'indexer_run:r1', status: 'committed', n: 1 }],
    });
    await svc.listIndexers({ companyId: 'co_test' });
    expect(new Set(rec.tenants)).toEqual(new Set(['co_test']));
  });
});

describe('IndexerOperatorService.listRuns()', () => {
  it('matches IndexerRunListResponseSchema', async () => {
    const { svc } = makeService({
      runs: {
        legal: [
          {
            id: 'indexer_run:r1',
            docId: 'source_document:d1',
            packId: 'legal',
            packVersion: '1.0.0',
            status: 'succeeded',
            createdAt: '2026-09-01T00:00:00.000Z',
            finishedAt: '2026-09-01T00:00:09.000Z',
            stats: { chunks: 2, entities: 5, facts: 7, relations: 1, durationMs: 9000 },
          },
        ],
      },
      candidates: [{ runId: 'indexer_run:r1', status: 'merged', n: 3 }],
    });
    const out = await svc.listRuns({ companyId: 'co_test', packId: 'legal' });
    const parsed = IndexerRunListResponseSchema.safeParse(out);
    if (!parsed.success) {
      throw new Error(`run list drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(out.runs[0]?.candidates.merged).toBe(3);
    expect(out.runs[0]?.stats?.facts).toBe(7);
  });

  it('404s for a pack that is not a declared indexer of this tenant', async () => {
    const { svc } = makeService({});
    await expect(svc.listRuns({ companyId: 'co_test', packId: 'core' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.listRuns({ companyId: 'co_test', packId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('clamps the detail limit', async () => {
    const { svc, rec } = makeService({});
    const out = await svc.listRuns({ companyId: 'co_test', packId: 'legal', limit: 9999 });
    expect(out.window.runCap).toBe(200);
    expect(rec.sql.some((s) => s.includes('LIMIT 200'))).toBe(true);
  });
});

describe('IndexerAdminController — gate and tenant fence', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('404s both routes while the flag is off', async () => {
    process.env[FLAG] = '0';
    const { svc } = makeService({});
    const c = makeController(svc);
    await expect(c.list(req())).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.runs(req(), 'legal')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves both routes once the flag is on', async () => {
    process.env[FLAG] = '1';
    const { svc } = makeService({});
    const c = makeController(svc);
    await expect(c.list(req())).resolves.toMatchObject({ tenant: 'co_test' });
    await expect(c.runs(req(), 'legal')).resolves.toMatchObject({ packId: 'legal' });
  });

  it('denies a plain admin asking for another tenant', async () => {
    process.env[FLAG] = '1';
    const { svc, rec } = makeService({});
    const c = makeController(svc);
    await expect(c.list(req(), { tenant: 'co_other' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.runs(req(), 'legal', { tenant: 'co_other' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(rec.tenants).toEqual([]);
  });

  it('passes the caller’s own tenant through unchanged', async () => {
    process.env[FLAG] = '1';
    const { svc } = makeService({});
    const out = await makeController(svc).list(req(), { tenant: 'co_test' });
    expect(out.tenant).toBe('co_test');
  });

  it('ignores unparsable query numbers instead of failing', async () => {
    process.env[FLAG] = '1';
    const { svc } = makeService({});
    const out = await makeController(svc).list(req(), { days: 'abc', runCap: 'xyz' });
    expect(out.window.days).toBe(7);
    expect(out.window.runCap).toBe(50);
  });
});
