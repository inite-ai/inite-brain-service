/**
 * The dead-letter queue (GET /v1/admin/dlq, the overview's recent list)
 * shows refused claims, and a refused claim keeps its value in
 * `payload.object`. brain:admin alone never widened what a key may read:
 *
 *  - a value whose predicate requires brain:read_pii is redacted without
 *    that scope (ids, predicate and reason stay);
 *  - a user-bound key sees its own and tenant-global rows only; another
 *    user's row and a row whose owner cannot be determined are absent;
 *  - a tenant-wide key sees another user's personal row redacted.
 *
 * And DELETE /v1/admin/dlq/:companyId/:id:
 *  - the path tenant must be the caller's own unless it is the platform
 *    operator (403 otherwise);
 *  - the row is addressed as a record (`WHERE id = $id` against the
 *    string the listing hands out matched nothing — a silent no-op).
 */
import { ForbiddenException } from '@nestjs/common';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { AdminService } from '../src/admin/admin.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import { runWithRequestContext } from '../src/common/request-context';
import type { SurrealService } from '../src/db/surreal.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import { PLATFORM_SCOPES, adminReq } from './helpers/admin-controllers';

const ADDRESS = '12 Rue de la Paix, 75002 Paris';

const deadLetters = [
  {
    id: 'ingest_dead_letter:pii',
    reason: 'create_returned_none',
    rejectedAt: '2026-11-20T10:00:00Z',
    payload: {
      entityId: 'knowledge_entity:jane',
      predicate: 'address',
      object: ADDRESS,
      source: { vertical: 'chat', evidence: [{ quote: `Jane lives at ${ADDRESS}` }] },
    },
  },
  {
    id: 'ingest_dead_letter:global',
    reason: 'create_returned_none',
    rejectedAt: '2026-11-20T09:00:00Z',
    payload: {
      entityId: 'knowledge_entity:acme',
      predicate: 'role',
      object: 'vendor',
      source: { vertical: 'docs', documentId: 'source_document:handbook' },
    },
  },
  {
    id: 'ingest_dead_letter:userB',
    reason: 'create_returned_none',
    rejectedAt: '2026-11-20T08:00:00Z',
    payload: {
      entityId: 'knowledge_entity:bdiary',
      predicate: 'role',
      object: 'userB private value',
      source: { vertical: 'chat' },
    },
  },
  {
    id: 'ingest_dead_letter:userA',
    reason: 'create_returned_none',
    rejectedAt: '2026-11-20T07:00:00Z',
    payload: {
      entityId: 'knowledge_entity:adiary',
      predicate: 'role',
      object: 'userA own value',
      source: { vertical: 'chat' },
    },
  },
];
const entities = [
  { id: 'knowledge_entity:jane' },
  { id: 'knowledge_entity:acme' },
  { id: 'knowledge_entity:bdiary', userId: 'userB' },
  { id: 'knowledge_entity:adiary', userId: 'userA' },
];
const documents = [{ id: 'source_document:handbook' }];

function inside(rows: Array<{ id: string }>, ids: unknown): Array<{ id: string }> {
  const wanted = new Set((ids as unknown[]).map(String));
  return rows.filter((r) => wanted.has(r.id));
}

function makeService(seen: { sql: string[]; vars: Array<Record<string, unknown>> }) {
  const db = {
    query: async (sql: string, vars: Record<string, unknown> = {}) => {
      seen.sql.push(sql);
      seen.vars.push(vars);
      if (sql.includes('FROM ingest_dead_letter')) return [deadLetters];
      if (sql.includes('FROM knowledge_entity')) return [inside(entities, vars.ids)];
      if (sql.includes('FROM source_document')) return [inside(documents, vars.ids)];
      if (sql.startsWith('DELETE')) return [[{ id: 'ingest_dead_letter:x' }]];
      return [[]];
    },
  };
  const surreal = {
    withCompany: (_c: string, fn: (d: unknown) => unknown) => fn(db),
  } as unknown as SurrealService;
  const apiKeys = {
    knownCompanyIds: () => ['tenant-a', 'tenant-b'],
    fanOutRoster: () => ['tenant-a', 'tenant-b'],
  } as unknown as ApiKeyService;
  const registry = {
    rowPolicyLookup: async () => (p: string) =>
      p === 'address'
        ? { requiresScope: 'brain:read_pii', piiClass: 'address' }
        : { piiClass: 'none' },
  } as unknown as PredicateRegistryService;
  return new AdminService(apiKeys, surreal, {} as MetricsService, registry);
}

function list(scopes: string[], authUserId?: string) {
  const svc = makeService({ sql: [], vars: [] });
  return runWithRequestContext({ correlationId: 't', ...(authUserId ? { authUserId } : {}) }, () =>
    svc.listDeadLetter({}, adminReq(scopes as never)),
  );
}

const ADMIN = ['brain:read', 'brain:write', 'brain:admin'];

describe('dead-letter read fences', () => {
  it('without brain:read_pii a PII value and its evidence quote are redacted; ids and reason stay', async () => {
    const rows = await list(ADMIN);
    const pii = rows.find((r) => r.id === 'ingest_dead_letter:pii')!;
    expect(pii.payload).toMatchObject({
      entityId: 'knowledge_entity:jane',
      predicate: 'address',
      object: '[redacted]',
      source: { vertical: 'chat' },
      redacted: true,
    });
    expect(pii.reason).toBe('create_returned_none');
    expect(JSON.stringify(rows)).not.toContain('Rue de la Paix');
  });

  it('brain:read_pii shows the value', async () => {
    const rows = await list([...ADMIN, 'brain:read_pii']);
    expect(rows.find((r) => r.id === 'ingest_dead_letter:pii')!.payload.object).toBe(ADDRESS);
  });

  it("a tenant-wide key sees a user's personal row redacted, tenant rows in full", async () => {
    const rows = await list([...ADMIN, 'brain:read_pii']);
    const byId = new Map(rows.map((r) => [r.id, r.payload]));
    expect(byId.get('ingest_dead_letter:userB')!.object).toBe('[redacted]');
    expect(byId.get('ingest_dead_letter:global')!.object).toBe('vendor');
  });

  it("a user-bound key sees its own and tenant-global rows only (another user's and unknown-owner rows are absent)", async () => {
    const rows = await list([...ADMIN, 'brain:read_pii'], 'userA');
    expect(rows.map((r) => r.id).sort()).toEqual([
      'ingest_dead_letter:global',
      'ingest_dead_letter:userA',
    ]);
    expect(rows.find((r) => r.id === 'ingest_dead_letter:userA')!.payload.object).toBe(
      'userA own value',
    );
    expect(JSON.stringify(rows)).not.toContain('userB private value');
    expect(JSON.stringify(rows)).not.toContain('Rue de la Paix');
  });
});

describe('dead-letter delete', () => {
  const savedGate = process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
    else process.env.BRAIN_TENANT_OVERRIDE_ENABLED = savedGate;
  });

  it("a tenant admin cannot delete another tenant's row", async () => {
    const seen = { sql: [] as string[], vars: [] as Array<Record<string, unknown>> };
    await expect(
      makeService(seen).deleteDeadLetter(adminReq(), {
        companyId: 'tenant-b',
        id: 'ingest_dead_letter:x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(seen.sql).toEqual([]);
  });

  it('deletes its own tenant row by record, not by string comparison', async () => {
    const seen = { sql: [] as string[], vars: [] as Array<Record<string, unknown>> };
    const ok = await makeService(seen).deleteDeadLetter(adminReq(), {
      companyId: 'tenant-a',
      id: 'ingest_dead_letter:x',
    });
    expect(ok).toBe(true);
    expect(seen.sql[0]).toContain(`type::record('ingest_dead_letter', $tail)`);
    expect(seen.vars[0]).toEqual({ tail: 'x' });
  });

  it('the platform operator may reach another tenant', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    const seen = { sql: [] as string[], vars: [] as Array<Record<string, unknown>> };
    const ok = await makeService(seen).deleteDeadLetter(adminReq(PLATFORM_SCOPES), {
      companyId: 'tenant-b',
      id: 'ingest_dead_letter:x',
    });
    expect(ok).toBe(true);
  });
});
