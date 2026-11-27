/**
 * The source-item drawer (GET /v1/admin/source-connections/:id/items/:itemId)
 * reads memory content — a turn's text and fact values — so it carries the
 * documented read fences, and brain:admin alone widens nothing:
 *
 *  - a PII-classed turn is absent without brain:read_pii;
 *  - a fact whose predicate requires brain:read_pii is absent without it
 *    (the same verdict GET /v1/facts/:id gives — a 404 there);
 *  - another end user's item / turn / facts are invisible: a user-bound
 *    key is pinned to its own user, and a key acting for no one sees
 *    tenant-global rows only (fail-closed).
 *
 * Reported against 2.4 / main @ 6bfbd35: the drawer selected episode text
 * and fact objects with no PII gate, no predicate scope gate and no userId
 * fence. The fake DB below honours the fence clauses the service sends
 * (userId, piiClass), so a query that drops one shows up as a leak here.
 */
import { NotFoundException } from '@nestjs/common';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { runWithRequestContext } from '../src/common/request-context';
import type { SurrealService } from '../src/db/surreal.service';
import { SourceInspectService } from '../src/source-plane/source-inspect.service';

const CONN = 'source_connection:labconn';

interface Row {
  id: string;
  userId?: string;
  piiClass?: string[];
  [k: string]: unknown;
}

const items: Row[] = [
  {
    id: 'source_item:item1',
    connectionId: CONN,
    externalId: 'e1',
    state: 'indexed',
    episodeId: 'episode:turn1',
    scope: [],
  },
  {
    id: 'source_item:item2',
    connectionId: CONN,
    externalId: 'e2',
    state: 'indexed',
    episodeId: 'episode:turn2',
    userId: 'userB',
    scope: ['user:userB'],
  },
];
const episodes: Row[] = [
  {
    id: 'episode:turn1',
    text: 'Jane lives at 12 Rue de la Paix, 75002 Paris',
    piiClass: ['address'],
  },
  { id: 'episode:turn2', text: 'userB private turn', userId: 'userB' },
];
const facts: Row[] = [
  {
    id: 'knowledge_fact:fact1',
    predicate: 'address',
    object: '12 Rue de la Paix, 75002 Paris',
    ep: 'episode:turn1',
  },
  { id: 'knowledge_fact:fact1b', predicate: 'role', object: 'engineer', ep: 'episode:turn1' },
  {
    id: 'knowledge_fact:fact2',
    predicate: 'role',
    object: 'userB fact',
    ep: 'episode:turn2',
    userId: 'userB',
  },
];

/** Applies the fence clauses the service sends, nothing else. */
function fenced(rows: Row[], sql: string, vars: Record<string, unknown>): Row[] {
  return rows.filter((r) => {
    if (sql.includes('userId = $scopeUserId')) {
      if (r.userId !== undefined && r.userId !== vars.scopeUserId) return false;
    } else if (sql.includes('userId IS NONE') && r.userId !== undefined) {
      return false;
    }
    if (sql.includes('piiClass IS NONE') && r.piiClass !== undefined) return false;
    return true;
  });
}

const db = {
  query: async (sql: string, vars: Record<string, unknown> = {}) => {
    const tail = vars.tail as string | undefined;
    if (sql.includes(`'source_item'`)) {
      return [
        fenced(
          items.filter((r) => r.id === `source_item:${tail}`),
          sql,
          vars,
        ),
      ];
    }
    if (sql.includes(`'episode'`)) {
      return [
        fenced(
          episodes.filter((r) => r.id === `episode:${tail}`),
          sql,
          vars,
        ),
      ];
    }
    if (sql.includes('FROM knowledge_fact')) {
      return [
        fenced(
          facts.filter((f) => f.ep === vars.ref),
          sql,
          vars,
        ).map((f) => ({ ...f, entityId: 'entity:jane', confidence: 0.9, status: 'active' })),
      ];
    }
    return [[]];
  },
};

const surreal = {
  withCompany: (_c: string, fn: (d: unknown) => unknown) => fn(db),
} as unknown as SurrealService;
const registry = {
  rowPolicyLookup: async () => (p: string) =>
    p === 'address'
      ? { requiresScope: 'brain:read_pii', piiClass: 'address' }
      : { piiClass: 'none' },
} as unknown as PredicateRegistryService;
const service = new SourceInspectService(surreal, registry);

function drawer(
  itemId: string,
  scopes: string[],
  opts: { authUserId?: string; userId?: string } = {},
) {
  return runWithRequestContext(
    { correlationId: 't', ...(opts.authUserId ? { authUserId: opts.authUserId } : {}) },
    () => service.item('lab', { connectionId: CONN, itemId, userId: opts.userId, scopes }),
  );
}

const ADMIN = ['brain:read', 'brain:write', 'brain:admin'];

describe('source-item drawer read fences', () => {
  it('an admin key without brain:read_pii sees neither the PII turn nor the PII-scoped fact', async () => {
    const out = await drawer('source_item:item1', ADMIN);
    expect(out.episode).toBeNull();
    expect(out.facts.map((f) => f.id)).toEqual(['knowledge_fact:fact1b']);
    expect(JSON.stringify(out)).not.toContain('Rue de la Paix');
  });

  it('brain:read_pii lets the turn and the scoped fact through', async () => {
    const out = await drawer('source_item:item1', [...ADMIN, 'brain:read_pii']);
    expect(out.episode?.text).toContain('Rue de la Paix');
    expect(out.facts.map((f) => f.id)).toEqual(['knowledge_fact:fact1', 'knowledge_fact:fact1b']);
  });

  it("a user-bound admin key cannot open another user's item", async () => {
    await expect(
      drawer('source_item:item2', [...ADMIN, 'brain:read_pii'], { authUserId: 'userA' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a user-bound key asserting someone else's userId is refused", async () => {
    await expect(
      drawer('source_item:item2', ADMIN, { authUserId: 'userA', userId: 'userB' }),
    ).rejects.toThrow(/does not match/);
  });

  it('a key acting for no one sees tenant-global items only (fail-closed)', async () => {
    await expect(drawer('source_item:item2', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the owner (or a tenant-wide key naming them) sees the user's item, turn and facts", async () => {
    for (const opts of [{ authUserId: 'userB' }, { userId: 'userB' }]) {
      const out = await drawer('source_item:item2', ADMIN, opts);
      expect(out.episode?.text).toBe('userB private turn');
      expect(out.facts.map((f) => f.id)).toEqual(['knowledge_fact:fact2']);
    }
  });
});
