/**
 * A user-bound credential (the guard's `authUserId`) holds one user's
 * slice of the tenant, on the source plane and the evidence ingest
 * routes as everywhere else:
 *
 *  - the item catalogue of a connection lists tenant-global items plus
 *    the caller's own; with no user in play it is tenant-global only
 *    (fail-closed), and a tenant-wide key names the user with ?userId=;
 *  - another user's personal connection is a 404 to a user-bound key —
 *    on read, update, delete, records push and the agent protocol — and
 *    a user-bound key cannot create a connection owned by someone else;
 *  - principals: identity emails need brain:read_pii; a user-bound key
 *    links accounts to itself only;
 *  - evidence registration pins `userId` and refuses scope tags the
 *    principal does not hold.
 *
 * The fake DB honours the userId fence clauses the services send, so a
 * query that drops one shows up as a leak here. A tenant-wide key (no
 * authUserId) keeps its tenant-wide authority throughout.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';
import type { MembershipService } from '../src/auth/membership.service';
import { runWithRequestContext } from '../src/common/request-context';
import type { SurrealService } from '../src/db/surreal.service';
import { EvidenceIngestController } from '../src/evidence/evidence-ingest.controller';
import type { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import type { EvidenceUploadService } from '../src/evidence/evidence-upload.service';
import { pinEvidenceWriteScope } from '../src/evidence/evidence-write-scope';
import type { IngestEvidenceAssetDto } from '../src/evidence/dto/ingest-evidence-asset.dto';
import { AdminSourcePrincipalsController } from '../src/source-plane/admin-source-principals.controller';
import { AgentRunService } from '../src/source-plane/agent-run.service';
import type { AgentSyncService } from '../src/source-plane/agent-sync.service';
import { RecordsPushService } from '../src/source-plane/records/records-push.service';
import { SourceConnectionService } from '../src/source-plane/source-connection.service';
import type { SourcesService } from '../src/sources/sources.service';
import { SourceItemService } from '../src/source-plane/source-item.service';
import type { JobRunService } from '../src/jobs/job-run.service';

const CONN_ORG = 'source_connection:org';
const CONN_B = 'source_connection:bpersonal';

interface Row {
  id: string;
  userId?: string;
  [k: string]: unknown;
}

const connections: Row[] = [
  { id: CONN_ORG, host: 'agent:lap', shape: 'structure', status: 'active', scope: [] },
  {
    id: CONN_B,
    host: 'agent:lap',
    shape: 'structure',
    status: 'active',
    userId: 'userB',
    scope: ['user:userB'],
  },
];
const items: Row[] = [
  { id: 'source_item:g', connectionId: CONN_ORG, externalId: 'global.md', state: 'indexed' },
  {
    id: 'source_item:a',
    connectionId: CONN_ORG,
    externalId: 'a-private.md',
    state: 'indexed',
    userId: 'userA',
  },
  {
    id: 'source_item:b',
    connectionId: CONN_ORG,
    externalId: 'b-private.md',
    state: 'indexed',
    userId: 'userB',
  },
];

/** Applies the userId fence clauses the service sends, nothing else. */
function fenced(rows: Row[], sql: string, vars: Record<string, unknown>): Row[] {
  return rows.filter((r) => {
    if (sql.includes('userId = $scopeUserId')) {
      return r.userId === undefined || r.userId === vars.scopeUserId;
    }
    if (sql.includes('userId IS NONE')) return r.userId === undefined;
    return true;
  });
}

const writes: string[] = [];
const db = {
  query: async (sql: string, vars: Record<string, unknown> = {}) => {
    if (/^\s*(UPDATE|DELETE|CREATE)/.test(sql)) writes.push(sql);
    if (sql.includes(`type::record('source_connection', $tail) LIMIT 1`)) {
      return [connections.filter((c) => c.id === `source_connection:${String(vars.tail)}`)];
    }
    if (sql.includes('FROM source_connection')) return [connections];
    if (sql.includes('FROM source_item')) {
      const rows = fenced(
        items.filter((i) => i.connectionId === `source_connection:${String(vars.tail)}`),
        sql,
        vars,
      );
      return [sql.includes('count()') ? [{ n: rows.length }] : rows];
    }
    return [[]];
  },
};
const surreal = {
  withCompany: (_c: string, fn: (d: unknown) => unknown) => fn(db),
} as unknown as SurrealService;

const connectionService = new SourceConnectionService(surreal, {} as SourcesService);
const itemService = new SourceItemService(surreal);

function as<T>(authUserId: string | undefined, fn: () => T): T {
  return runWithRequestContext({ correlationId: 't', ...(authUserId ? { authUserId } : {}) }, fn);
}

beforeEach(() => {
  writes.length = 0;
});

describe('item catalogue: the per-user read fence', () => {
  const list = (authUserId?: string, userId?: string) =>
    as(authUserId, () =>
      itemService.list('lab', { connectionId: CONN_ORG, userId, limit: 50, offset: 0 }),
    );
  const ids = async (p: Promise<{ items: Array<{ externalId: string }>; total: number }>) => {
    const out = await p;
    return { names: out.items.map((i) => i.externalId).sort(), total: out.total };
  };

  it('a key acting for no one lists tenant-global items only (fail-closed)', async () => {
    expect(await ids(list())).toEqual({ names: ['global.md'], total: 1 });
  });

  it("a user-bound key lists its own and tenant-global items, never another user's", async () => {
    expect(await ids(list('userA'))).toEqual({ names: ['a-private.md', 'global.md'], total: 2 });
  });

  it("a user-bound key naming someone else's userId is refused", async () => {
    await expect(list('userA', 'userB')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a tenant-wide key names the user whose items it wants', async () => {
    expect(await ids(list(undefined, 'userB'))).toEqual({
      names: ['b-private.md', 'global.md'],
      total: 2,
    });
  });
});

describe("connections: another user's personal connection is a 404", () => {
  it('get / update / remove refuse a user-bound key that is not the owner, before any write', async () => {
    await as('userA', async () => {
      await expect(connectionService.get('lab', CONN_B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        connectionService.update('lab', CONN_B, { label: 'mine now' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(connectionService.remove('lab', CONN_B)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    expect(writes).toEqual([]);
  });

  it('the owner, a tenant-wide key, and any key on an org connection still act', async () => {
    await expect(as('userB', () => connectionService.get('lab', CONN_B))).resolves.toMatchObject({
      id: CONN_B,
    });
    await expect(as(undefined, () => connectionService.get('lab', CONN_B))).resolves.toMatchObject({
      id: CONN_B,
    });
    await expect(as('userA', () => connectionService.get('lab', CONN_ORG))).resolves.toMatchObject({
      id: CONN_ORG,
    });
  });

  it("the list hides other users' personal connections from a user-bound key only", async () => {
    const ids = async (u?: string) =>
      (await as(u, () => connectionService.list('lab'))).map((c) => c.id).sort();
    expect(await ids('userA')).toEqual([CONN_ORG]);
    expect(await ids('userB')).toEqual([CONN_B, CONN_ORG].sort());
    expect(await ids()).toEqual([CONN_B, CONN_ORG].sort());
  });

  it('a user-bound key cannot create a connection owned by another user', async () => {
    await expect(
      as('userA', () =>
        connectionService.create('lab', {
          packId: 'p',
          sourceId: 's',
          vertical: 'docs',
          ownerUserId: 'userB',
        } as never),
      ),
    ).rejects.toThrow(/ownerUserId does not match/);
  });
});

describe("writes into another user's personal connection", () => {
  const jobs = {
    start: jest.fn(async () => ({ runId: 'run-12345678' })),
    get: jest.fn(async () => ({
      runId: 'run-12345678',
      jobType: 'source_sync',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: { connectionId: CONN_B, agentId: 'lap' },
    })),
    list: jest.fn(async () => []),
    updateProgress: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  } as unknown as JobRunService;
  const sync = {
    applyDeltas: jest.fn(async () => ({ fetch: [] })),
    ingestItem: jest.fn(async () => ({ status: 'ingested' })),
    finish: jest.fn(async () => ({})),
  } as unknown as AgentSyncService;
  const push = new RecordsPushService(
    connectionService,
    {} as never,
    {} as never,
    {} as never,
    jobs,
  );
  const runs = new AgentRunService(jobs, connectionService, sync);

  afterEach(() => jest.clearAllMocks());

  it('records push and every agent-run step answer 404 to a user-bound key that is not the owner', async () => {
    await as('userA', async () => {
      await expect(
        push.push('lab', {
          connectionId: CONN_B,
          body: { records: [] } as never,
          actor: 'a',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(runs.begin('lab', CONN_B, { agentId: 'lap' } as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        runs.deltas('lab', { connectionId: CONN_B, runId: 'run-12345678', deltas: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        runs.item('lab', {
          connectionId: CONN_B,
          runId: 'run-12345678',
          externalId: 'x',
          item: {} as never,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        runs.finish('lab', {
          connectionId: CONN_B,
          runId: 'run-12345678',
          req: { status: 'succeeded' } as never,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(jobs.start).not.toHaveBeenCalled();
    expect(sync.applyDeltas).not.toHaveBeenCalled();
    expect(sync.ingestItem).not.toHaveBeenCalled();
    expect(sync.finish).not.toHaveBeenCalled();
  });

  it('the owner still drives its connection', async () => {
    await as('userB', async () => {
      await runs.deltas('lab', { connectionId: CONN_B, runId: 'run-12345678', deltas: [] });
    });
    expect(sync.applyDeltas).toHaveBeenCalledTimes(1);
  });

  it("the agent's host listing leaves out other users' personal connections", async () => {
    const hostIds = async (u?: string) =>
      (await as(u, () => runs.listForHost('lab', 'agent:lap'))).connections.map(
        (c) => c.connection.id,
      );
    const sourceContext = jest
      .spyOn(connectionService, 'sourceContext')
      .mockResolvedValue({ source: null } as never);
    expect(await hostIds('userA')).toEqual([CONN_ORG]);
    expect((await hostIds()).sort()).toEqual([CONN_B, CONN_ORG].sort());
    sourceContext.mockRestore();
  });
});

describe('principals', () => {
  const saved = process.env.SOURCE_PRINCIPALS;
  beforeAll(() => {
    process.env.SOURCE_PRINCIPALS = '1';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SOURCE_PRINCIPALS;
    else process.env.SOURCE_PRINCIPALS = saved;
  });

  const link = jest.fn(async () => undefined);
  const membership = {
    identities: async () => [
      {
        externalId: 'acct-free',
        handle: 'free',
        displayName: 'Free',
        email: 'free@example.test',
        userId: null,
        linkedBy: null,
      },
      {
        externalId: 'acct-b',
        handle: 'bee',
        displayName: 'Bee',
        email: 'bee@example.test',
        userId: 'userB',
        linkedBy: 'operator',
      },
    ],
    tuplesOf: async () => [],
    epoch: async () => 1,
    link,
  } as unknown as MembershipService;
  const controller = new AdminSourcePrincipalsController(connectionService, membership);
  const req = (scopes: string[]) =>
    ({ brainAuth: { companyId: 'lab', scopes } }) as unknown as AuthenticatedRequest;
  const ADMIN = ['brain:read', 'brain:write', 'brain:admin'];

  afterEach(() => link.mockClear());

  it('identity emails need brain:read_pii; the field stays, as null', async () => {
    const without = await as(undefined, () => controller.list(req(ADMIN), CONN_ORG));
    expect(without.identities.map((i) => i.email)).toEqual([null, null]);
    expect(JSON.stringify(without)).not.toContain('@example.test');
    const withPii = await as(undefined, () =>
      controller.list(req([...ADMIN, 'brain:read_pii']), CONN_ORG),
    );
    expect(withPii.identities.map((i) => i.email)).toEqual([
      'free@example.test',
      'bee@example.test',
    ]);
  });

  it('a user-bound key links an account to itself only, and cannot take one from another user', async () => {
    await as('userA', async () => {
      await expect(
        controller.link(req(ADMIN), CONN_ORG, { externalId: 'acct-free', userId: 'userB' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.link(req(ADMIN), CONN_ORG, { externalId: 'acct-b', userId: null }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.link(req(ADMIN), CONN_ORG, { externalId: 'acct-b', userId: 'userA' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    expect(link).not.toHaveBeenCalled();
    await as('userA', () =>
      controller.link(req(ADMIN), CONN_ORG, { externalId: 'acct-free', userId: 'userA' }),
    );
    expect(link).toHaveBeenCalledWith(expect.objectContaining({ userId: 'userA' }));
  });

  it('a tenant-wide admin key links any account to any user', async () => {
    await as(undefined, () =>
      controller.link(req(ADMIN), CONN_ORG, { externalId: 'acct-b', userId: 'userC' }),
    );
    expect(link).toHaveBeenCalledWith(expect.objectContaining({ userId: 'userC' }));
  });
});

describe('evidence registration: owner and scope', () => {
  it('pins userId and refuses scope tags the principal does not hold', () => {
    as('userA', () => {
      expect(pinEvidenceWriteScope({})).toEqual({ userId: 'userA', scope: undefined });
      expect(pinEvidenceWriteScope({ scope: ['user:userA'] })).toEqual({
        userId: 'userA',
        scope: ['user:userA'],
      });
      expect(() => pinEvidenceWriteScope({ userId: 'userB' })).toThrow(ForbiddenException);
      expect(() => pinEvidenceWriteScope({ scope: ['user:userB'] })).toThrow(ForbiddenException);
      expect(() => pinEvidenceWriteScope({ scope: ['team:conn:eng'] })).toThrow(ForbiddenException);
    });
  });

  it('a tenant-wide key keeps naming any user and scope', () => {
    as(undefined, () => {
      expect(pinEvidenceWriteScope({ userId: 'userB', scope: ['user:userB'] })).toEqual({
        userId: 'userB',
        scope: ['user:userB'],
      });
      expect(pinEvidenceWriteScope({})).toEqual({ userId: undefined, scope: undefined });
    });
  });

  it('POST /v1/ingest/evidence-asset registers under the pinned owner, and writes nothing on a foreign one', async () => {
    const registerAsset = jest.fn(async () => ({
      assetId: 'evidence_asset:x',
      availability: 'external',
      deduped: false,
    }));
    const controller = new EvidenceIngestController(
      { registerAsset } as unknown as EvidenceStoreService,
      {} as EvidenceUploadService,
    );
    const body = {
      modality: 'image',
      mediaType: 'image/png',
      byteHash: 'a'.repeat(64),
      byteLength: 10,
      occurredAt: '2026-11-01T00:00:00Z',
      originUri: 'https://example.test/x.png',
      vertical: 'media',
    } as IngestEvidenceAssetDto;
    const r = req();
    await expect(
      as('userA', () => controller.ingestEvidenceAsset(r, { ...body, userId: 'userB' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      as('userA', () => controller.ingestEvidenceAsset(r, { ...body, scope: ['user:userB'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(registerAsset).not.toHaveBeenCalled();
    await as('userA', () => controller.ingestEvidenceAsset(r, body));
    expect(registerAsset).toHaveBeenCalledWith(
      'lab',
      expect.objectContaining({ userId: 'userA', scope: undefined }),
    );
  });

  function req(): AuthenticatedRequest {
    return { brainAuth: { companyId: 'lab', scopes: ['brain:write'] } } as AuthenticatedRequest;
  }
});
