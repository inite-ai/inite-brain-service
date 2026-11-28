/**
 * Dreams resolve and corroborate facts of any user and any predicate, and
 * the run's detail carried both facts' values (`winnerObject` /
 * `loserObject`, `incumbentObject` / `corroboratingObject`). They reached
 * a tenant's brain:admin past brain:read_pii and past the per-user fence:
 *
 *  - the run trigger (POST /v1/dreams/run, POST /v1/admin/dreams/run)
 *    now answers counts and ids, every value `[redacted]` (the contract
 *    keeps the string field);
 *  - emit rows are written without the values;
 *  - the per-run emit drill applies userReadFence and the registry row
 *    policy to rows written before that: a value the caller may not read
 *    is redacted, and a user-bound key does not see another user's emit.
 */
import type { ConfigService } from '@nestjs/config';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { AdminController } from '../src/admin/admin.controller';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';
import type { CompactionService } from '../src/compaction/compaction.service';
import { runWithRequestContext } from '../src/common/request-context';
import { DreamsRunResponseSchema } from '../src/contracts/admin/write-responses.schema';
import type { SurrealService } from '../src/db/surreal.service';
import { DreamsController } from '../src/dreams/dreams.controller';
import { DreamsService, type DreamsTenantStats } from '../src/dreams/dreams.service';
import type { DreamsDedupService } from '../src/dreams/dedup.service';
import type { DreamsResolverService } from '../src/dreams/resolver.service';
import { makeAdminController } from './helpers/admin-controllers';

const ADDRESS = '12 Rue de la Paix, 75002 Paris';

interface FactRow {
  id: string;
  predicate: string;
  userId?: string;
}

const facts: FactRow[] = [
  { id: 'knowledge_fact:addrNew', predicate: 'address' },
  { id: 'knowledge_fact:addrOld', predicate: 'address' },
  { id: 'knowledge_fact:bNew', predicate: 'role', userId: 'userB' },
  { id: 'knowledge_fact:bOld', predicate: 'role', userId: 'userB' },
  { id: 'knowledge_fact:gNew', predicate: 'role' },
  { id: 'knowledge_fact:gOld', predicate: 'role' },
];

const emits = [
  {
    runId: 'r1',
    kind: 'identity_link',
    ts: '2026-11-20T00:00:00Z',
    subject: 'knowledge_entity:a',
    object: 'knowledge_entity:b',
    detail: { survivorId: 'knowledge_entity:a', loserId: 'knowledge_entity:b', cosine: 0.97 },
  },
  {
    runId: 'r1',
    kind: 'resolution',
    ts: '2026-11-20T00:00:01Z',
    subject: 'knowledge_fact:addrNew',
    object: 'knowledge_fact:addrOld',
    detail: {
      winnerFactId: 'knowledge_fact:addrNew',
      loserFactId: 'knowledge_fact:addrOld',
      predicate: 'address',
      entityId: 'knowledge_entity:jane',
      winnerObject: ADDRESS,
      loserObject: '1 Old Street',
    },
  },
  {
    runId: 'r1',
    kind: 'corroboration',
    ts: '2026-11-20T00:00:02Z',
    subject: 'knowledge_fact:bNew',
    object: 'knowledge_fact:bOld',
    detail: {
      incumbentFactId: 'knowledge_fact:bNew',
      corroboratingFactId: 'knowledge_fact:bOld',
      predicate: 'role',
      entityId: 'knowledge_entity:bob',
      incumbentObject: 'userB private value',
      corroboratingObject: 'userB private value too',
      method: 'llm',
    },
  },
  {
    runId: 'r1',
    kind: 'resolution',
    ts: '2026-11-20T00:00:03Z',
    subject: 'knowledge_fact:gNew',
    object: 'knowledge_fact:gOld',
    detail: {
      winnerFactId: 'knowledge_fact:gNew',
      loserFactId: 'knowledge_fact:gOld',
      predicate: 'role',
      entityId: 'knowledge_entity:acme',
      winnerObject: 'vendor',
      loserObject: 'prospect',
    },
  },
];

/** Honours the id list and the userId fence clause the service sends, nothing else. */
function factQuery(sql: string, vars: Record<string, unknown>): FactRow[] {
  const ids = new Set((vars.ids as unknown[]).map(String));
  return facts.filter((f) => {
    if (!ids.has(f.id)) return false;
    if (sql.includes('userId = $scopeUserId')) {
      return f.userId === undefined || f.userId === vars.scopeUserId;
    }
    if (sql.includes('userId IS NONE')) return f.userId === undefined;
    return true;
  });
}

const inserted: Array<Record<string, unknown>> = [];
const db = {
  query: async (sql: string, vars: Record<string, unknown> = {}) => {
    if (sql.includes('FROM dream_emit')) return [emits];
    if (sql.includes('FROM knowledge_fact')) return [factQuery(sql, vars)];
    if (sql.includes('INSERT INTO dream_emit')) {
      inserted.push(...(vars.rows as Array<Record<string, unknown>>));
      return [[]];
    }
    return [[]];
  },
};

const surreal = {
  withCompany: <T>(_c: string, fn: (d: unknown) => Promise<T>) => fn(db),
} as unknown as SurrealService;
const registry = {
  rowPolicyLookup: async () => (p: string) =>
    p === 'address'
      ? { requiresScope: 'brain:read_pii', piiClass: 'address' }
      : { piiClass: 'none' },
} as unknown as PredicateRegistryService;
const config = { get: <T>(_k: string, d?: T) => d } as unknown as ConfigService;
const off = { isEnabled: () => false } as unknown;
const u = undefined;
const service = new DreamsService(
  surreal,
  {} as ApiKeyService,
  off as DreamsDedupService,
  off as DreamsResolverService,
  {} as CompactionService,
  config,
  u,
  u,
  u,
  u,
  u,
  u,
  u,
  u,
  u,
  registry,
);

function drill(scopes: string[], authUserId?: string) {
  return runWithRequestContext({ correlationId: 't', ...(authUserId ? { authUserId } : {}) }, () =>
    service.emitsForRun('lab', 'r1', scopes),
  );
}

function detailOf(rows: Array<Record<string, unknown>>, subject: string) {
  return rows.find((r) => r.subject === subject)?.detail as Record<string, unknown> | undefined;
}

const ADMIN = ['brain:read', 'brain:write', 'brain:admin'];

describe('dreams emit drill read fences', () => {
  it('without brain:read_pii the values of a PII-scoped resolution are redacted; ids stay', async () => {
    const rows = await drill(ADMIN);
    expect(detailOf(rows, 'knowledge_fact:addrNew')).toMatchObject({
      winnerFactId: 'knowledge_fact:addrNew',
      loserFactId: 'knowledge_fact:addrOld',
      predicate: 'address',
      winnerObject: '[redacted]',
      loserObject: '[redacted]',
    });
    expect(detailOf(rows, 'knowledge_fact:gNew')).toMatchObject({ winnerObject: 'vendor' });
    expect(detailOf(rows, 'knowledge_entity:a')).toMatchObject({ cosine: 0.97 });
    expect(JSON.stringify(rows)).not.toContain('Rue de la Paix');
  });

  it('brain:read_pii shows the PII-scoped values', async () => {
    const rows = await drill([...ADMIN, 'brain:read_pii']);
    expect(detailOf(rows, 'knowledge_fact:addrNew')).toMatchObject({ winnerObject: ADDRESS });
  });

  it("a tenant-wide key sees a user's personal emit with its values redacted", async () => {
    const rows = await drill([...ADMIN, 'brain:read_pii']);
    expect(detailOf(rows, 'knowledge_fact:bNew')).toMatchObject({
      incumbentObject: '[redacted]',
      corroboratingObject: '[redacted]',
    });
  });

  it("a user-bound key does not see another user's emit at all", async () => {
    const rows = await drill([...ADMIN, 'brain:read_pii'], 'userA');
    expect(rows.map((r) => r.subject)).not.toContain('knowledge_fact:bNew');
    expect(JSON.stringify(rows)).not.toContain('userB private');
    expect(rows).toHaveLength(3);
  });

  it('the owner sees its own emit in full', async () => {
    const rows = await drill([...ADMIN, 'brain:read_pii'], 'userB');
    expect(detailOf(rows, 'knowledge_fact:bNew')).toMatchObject({
      incumbentObject: 'userB private value',
    });
  });
});

describe('dreams emits are written without the values', () => {
  it('a resolution and a corroboration keep ids, predicate and entity only', async () => {
    inserted.length = 0;
    const stats: DreamsTenantStats = {
      companyId: 'lab',
      durationSeconds: 1,
      resolve: {
        pairsConsidered: 1,
        llmJudgements: 1,
        resolutionsApplied: 1,
        unsurePairs: 0,
        resolutions: [emits[1]!.detail as never],
      },
      corroborate: {
        groupsConsidered: 1,
        groupBacklog: 1,
        pairsConsidered: 1,
        llmJudgements: 1,
        corroborationsApplied: 1,
        unsurePairs: 0,
        corroborations: [emits[2]!.detail as never],
      },
    };
    const writer = service as unknown as {
      writeEmits(d: unknown, runId: string, s: DreamsTenantStats): Promise<void>;
    };
    await writer.writeEmits(db, 'r2', stats);
    expect(inserted).toHaveLength(2);
    const stored = JSON.stringify(inserted);
    expect(stored).not.toContain('Rue de la Paix');
    expect(stored).not.toContain('userB private');
    expect(inserted[0]!.detail).toMatchObject({
      winnerFactId: 'knowledge_fact:addrNew',
      predicate: 'address',
    });
  });
});

describe('the run trigger answers counts and ids, never values', () => {
  const runStats = async (): Promise<DreamsTenantStats> => ({
    companyId: 'lab',
    durationSeconds: 1,
    resolve: {
      pairsConsidered: 1,
      llmJudgements: 1,
      resolutionsApplied: 1,
      unsurePairs: 0,
      resolutions: [emits[1]!.detail as never],
    },
    corroborate: {
      groupsConsidered: 1,
      groupBacklog: 1,
      pairsConsidered: 1,
      llmJudgements: 1,
      corroborationsApplied: 1,
      unsurePairs: 0,
      corroborations: [emits[2]!.detail as never],
    },
  });
  const req = { brainAuth: { companyId: 'lab', scopes: ADMIN } } as unknown as AuthenticatedRequest;

  it('POST /v1/dreams/run', async () => {
    const ctl = new DreamsController({ runForTenant: runStats } as unknown as DreamsService);
    const out = await ctl.run(req, {} as never);
    expect(out.resolve?.resolutions[0]).toMatchObject({
      winnerFactId: 'knowledge_fact:addrNew',
      winnerObject: '[redacted]',
      loserObject: '[redacted]',
    });
    expect(out.corroborate?.corroborations[0]).toMatchObject({
      incumbentObject: '[redacted]',
      corroboratingObject: '[redacted]',
    });
    expect(JSON.stringify(out)).not.toContain('Rue de la Paix');
  });

  it('POST /v1/admin/dreams/run', async () => {
    const ctl: AdminController = makeAdminController({ dreams: { runForTenant: runStats } });
    const out = await ctl.runDreams(req, {} as never);
    // The contract keeps the value fields (strings): redacted, not removed.
    expect(DreamsRunResponseSchema.safeParse(out).success).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Rue de la Paix');
    expect(JSON.stringify(out)).not.toContain('userB private');
  });
});
