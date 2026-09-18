/**
 * MemoryContextService (src/ingest/memory-context.service.ts): the
 * read-only reader the extractor's memory context comes from.
 *  - the conversation's earlier turns, oldest first, without the turn
 *    itself, fenced to the user;
 *  - names from the turn, the earlier turns and the participants go
 *    through the resolver's read-only lookup; handles follow that order;
 *  - facts are capped per entity and keyed on the entity handle;
 *  - the vocabulary read is cached per tenant, an empty one is not;
 *  - a failing read degrades to the date alone, never to a throw.
 */
import { MemoryContextService } from '../src/ingest/memory-context.service';

interface Q {
  sql: string;
  params: Record<string, unknown> | undefined;
}

function make(opts: { fail?: boolean; predicates?: string[] } = {}) {
  const queries: Q[] = [];
  const db = {
    query: jest.fn(async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (opts.fail) throw new Error('db down');
      if (sql.includes('FROM episode')) {
        if (params?.c !== 'conv') return [[]];
        return [
          [
            {
              speaker: 'Mike',
              text: 'turn two',
              occurredAt: '2026-09-12T10:00:00Z',
              messageId: 'b',
            },
            { speaker: null, text: 'turn one', occurredAt: '2026-09-10T10:00:00Z', messageId: 'a' },
          ],
        ];
      }
      if (sql.includes('FROM knowledge_entity')) {
        return [
          [
            { id: 'knowledge_entity:rk', canonicalName: 'RK Imóveis', type: 'customer' },
            { id: 'knowledge_entity:rui', canonicalName: 'Rui Almeida', type: 'customer' },
            { id: 'knowledge_entity:old', canonicalName: 'Old', type: 'other', mergedInto: 'x' },
          ],
        ];
      }
      if (sql.includes('GROUP BY predicate')) {
        return [
          (opts.predicates ?? ['monthly_budget', 'project_start']).map((p) => ({
            predicate: p,
            n: 3,
          })),
        ];
      }
      if (sql.includes('FROM knowledge_edge')) {
        return [
          [
            {
              id: 'knowledge_edge:x1',
              in: 'knowledge_entity:rk',
              out: 'knowledge_entity:fly',
              kind: 'runs_on',
              fromName: 'RK Imóveis',
              toName: 'Fly.io',
              createdAt: '2026-09-11T00:00:00Z',
            },
            {
              id: 'knowledge_edge:x2',
              in: 'knowledge_entity:pedro',
              out: 'knowledge_entity:rui',
              kind: 'covers_for',
              fromName: 'Pedro Lima',
              toName: 'Rui Almeida',
              createdAt: '2026-09-17T00:00:00Z',
            },
            {
              id: 'knowledge_edge:x3',
              in: 'knowledge_entity:rui',
              out: 'knowledge_entity:rk',
              kind: 'works_at',
              fromName: 'Rui Almeida',
              toName: 'RK Imóveis',
              createdAt: '2026-09-10T00:00:00Z',
            },
          ],
        ];
      }
      if (sql.includes('FROM knowledge_fact')) {
        return [
          [
            {
              id: 'knowledge_fact:1',
              entityId: 'knowledge_entity:rk',
              predicate: 'a',
              object: '1',
              validFrom: '2026-09-16T00:00:00Z',
            },
            {
              id: 'knowledge_fact:2',
              entityId: 'knowledge_entity:rk',
              predicate: 'b',
              object: '2',
              validFrom: '2026-09-15T00:00:00Z',
            },
            {
              id: 'knowledge_fact:3',
              entityId: 'knowledge_entity:rui',
              predicate: 'c',
              object: '3',
              validFrom: '2026-09-14T00:00:00Z',
            },
            {
              id: 'knowledge_fact:4',
              entityId: 'knowledge_entity:unknown',
              predicate: 'd',
              object: '4',
              validFrom: '2026-09-13T00:00:00Z',
            },
          ],
        ];
      }
      return [[]];
    }),
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
  };
  const lookups: string[] = [];
  const entities = {
    resolveExistingByName: jest.fn(async (_d: unknown, e: { name: string }) => {
      lookups.push(e.name);
      if (e.name === 'RK Imóveis') return 'knowledge_entity:rk';
      if (e.name === 'Rui') return 'knowledge_entity:rui';
      if (e.name === 'Old') return 'knowledge_entity:old';
      return null;
    }),
  };
  const ner = {
    isReady: () => true,
    extract: jest.fn(async (text: string) => {
      if (text === 'current') return [{ text: 'Rui', type: 'PER', start: 0, end: 3, score: 0.99 }];
      if (text === 'turn two')
        return [{ text: 'RK Imóveis', type: 'ORG', start: 0, end: 10, score: 0.99 }];
      if (text === 'turn one') return [{ text: 'Old', type: 'ORG', start: 0, end: 3, score: 0.99 }];
      return [];
    }),
  };
  const svc = new MemoryContextService(surreal as never, entities as never, ner as never);
  return { svc, queries, lookups, ner };
}

describe('MemoryContextService.build', () => {
  it('reads the conversation, resolves the names in order, keys facts on the handles', async () => {
    const { svc, queries, lookups } = make();
    const ctx = await svc.build({
      companyId: 'co',
      text: 'current',
      occurredAt: '2026-09-16T11:00:00Z',
      conversationId: 'conv',
      messageId: 'c',
      userId: 'u1',
      participants: ['Mike'],
    });
    expect(ctx?.occurredAt).toBe('2026-09-16T11:00:00Z');
    // Oldest first, the current message excluded by the query.
    expect(ctx?.recentTurns.map((t) => t.text)).toEqual(['turn one', 'turn two']);
    const episodeQ = queries.find((q) => q.sql.includes('FROM episode'))!;
    expect(episodeQ.sql).toContain('messageId != $m');
    expect(episodeQ.sql).toContain('userId IS NONE OR userId = $u');
    expect(episodeQ.params).toMatchObject({ c: 'conv', m: 'c', u: 'u1' });
    // The participant first, then the turn's names, then the earlier turns' (newest first).
    expect(lookups).toEqual(['Mike', 'Rui', 'RK Imóveis', 'Old']);
    // A merged row is not a known entity; handles follow the lookup order.
    expect(ctx?.entities).toEqual([
      { handle: 'e1', id: 'knowledge_entity:rui', name: 'Rui Almeida', type: 'customer' },
      { handle: 'e2', id: 'knowledge_entity:rk', name: 'RK Imóveis', type: 'customer' },
    ]);
    // Facts keyed on the handle; a fact of an entity not in the list is
    // dropped; the relations follow under the same series.
    expect(ctx?.facts.map((f) => `${f.handle}:${f.entityHandle}:${f.id}`)).toEqual([
      'm1:e2:knowledge_fact:1',
      'm2:e2:knowledge_fact:2',
      'm3:e1:knowledge_fact:3',
      'm4:e2:knowledge_edge:x1',
      'm5:e1:knowledge_edge:x2',
      'm6:e1:knowledge_edge:x3',
    ]);
    expect(ctx?.facts[0]?.since).toBe('2026-09-16');
    expect(ctx?.predicates).toEqual(['monthly_budget', 'project_start']);
  });

  it("the known entities' relations follow the facts under the same handles, in their direction", async () => {
    const { svc, queries } = make();
    const ctx = await svc.build({ companyId: 'co', text: 'current', userId: 'u1' });
    const edgeQ = queries.find((q) => q.sql.includes('FROM knowledge_edge'))!;
    expect(edgeQ.sql).toContain('invalidatedAt IS NONE');
    expect(edgeQ.sql).toContain('userId IS NONE OR userId = $u');
    const rels = ctx!.facts.filter((f) => f.edge);
    // Handles continue the fact series; the known side anchors each line
    // (an in-edge to a known entity reads from its subject).
    expect(
      rels.map((f) => `${f.handle}:${f.entityHandle}:${f.edge}:${f.predicate}:${f.object}`),
    ).toEqual(['m2:e1:in:covers_for:Pedro Lima', 'm3:e1:out:works_at:RK Imóveis']);
    expect(rels[0]?.id).toBe('knowledge_edge:x2');
    expect(rels[0]?.since).toBe('2026-09-17');
  });

  it('caches the vocabulary per tenant, never an empty one, and re-reads after a commit', async () => {
    const { svc, queries } = make({ predicates: [] });
    const args = { companyId: 'co', text: 'x', occurredAt: '2026-09-16T00:00:00Z' };
    await svc.build(args);
    await svc.build(args);
    expect(queries.filter((q) => q.sql.includes('GROUP BY predicate'))).toHaveLength(2);
    const full = make();
    const reads = () => full.queries.filter((q) => q.sql.includes('GROUP BY predicate')).length;
    await full.svc.build(args);
    await full.svc.build(args);
    expect(reads()).toBe(1);
    // A commit on the tenant moves its vocabulary — with or without a conversation.
    full.svc.remember('co', undefined, []);
    await full.svc.build(args);
    expect(reads()).toBe(2);
    full.svc.remember('other', 'conv', ['knowledge_entity:rk']);
    await full.svc.build(args);
    expect(reads()).toBe(2);
  });

  it('degrades to the date alone when the store fails, and to nothing without a date', async () => {
    const { svc } = make({ fail: true });
    expect(
      await svc.build({ companyId: 'co', text: 'x', occurredAt: new Date('2026-09-16T00:00:00Z') }),
    ).toEqual({
      occurredAt: '2026-09-16T00:00:00.000Z',
      recentTurns: [],
      entities: [],
      facts: [],
      predicates: [],
    });
    expect(await svc.build({ companyId: 'co', text: 'x' })).toBeUndefined();
  });

  it('skips the conversation read without a conversationId and the NER when it is not ready', async () => {
    const { svc, queries, ner, lookups } = make();
    (ner as { isReady: () => boolean }).isReady = () => false;
    const ctx = await svc.build({ companyId: 'co', text: 'current', participants: ['RK Imóveis'] });
    expect(queries.some((q) => q.sql.includes('FROM episode'))).toBe(false);
    expect(lookups).toEqual(['RK Imóveis']);
    expect(ctx?.entities.map((e) => e.name)).toEqual(['RK Imóveis']);
  });
});

describe("MemoryContextService.remember — the conversation's last subjects", () => {
  it('a remembered entity joins the context after the named ones; other conversations are untouched', async () => {
    const { svc, lookups } = make();
    svc.remember('co', 'conv', ['knowledge_entity:rk']);
    svc.remember('co', 'other', ['knowledge_entity:rui']);
    const ctx = await svc.build({ companyId: 'co', text: 'current', conversationId: 'conv' });
    // NER found "Rui" (from the turn) → rui first, then the remembered rk.
    expect(lookups).toContain('Rui');
    expect(ctx?.entities.map((e) => e.name)).toEqual(['Rui Almeida', 'RK Imóveis']);
    const none = await svc.build({ companyId: 'co', text: 'nothing', conversationId: 'fresh' });
    expect(none?.entities).toEqual([]);
  });

  it('keeps the latest ids first, bounded per conversation, and ignores empty input', () => {
    const { svc } = make();
    svc.remember('co', 'conv', ['a']);
    svc.remember('co', 'conv', ['b', 'a']);
    svc.remember('co', undefined, ['z']);
    svc.remember('co', 'conv', []);
    expect(
      (svc as unknown as { conversationEntities: Map<string, string[]> }).conversationEntities.get(
        'co|conv',
      ),
    ).toEqual(['b', 'a']);
  });
});
