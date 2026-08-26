/**
 * Drift-1 claim grounding (migration 0115) — write side:
 *
 *  - groundingStatusOf truth table (the ONE grounded predicate):
 *    episode:-prefixed ids / non-prefixed ignored / empty arrays /
 *    evidence[] / conversationId '' vs non-empty / malformed shapes;
 *  - the post-resolve stamp through FactResolverService
 *    (EVIDENCE_GROUNDING_STAMP): one primary-key UPDATE per winner row
 *    with the computed status, none for REJECTED/CORROBORATED, and the
 *    OFF state pinned byte-identical (the db.query sequence is exactly
 *    the resolver calls — no UPDATE ever issued);
 *  - stamp failure warns and never fails the ingest.
 */
import { Logger } from '@nestjs/common';
import { groundingStatusOf } from '../src/common/grounding-status';
import { FactResolverService } from '../src/ingest/fact-resolver.service';

describe('groundingStatusOf — truth table', () => {
  const GROUNDED: Array<[string, unknown]> = [
    ['episode:-prefixed id in episodeIds', { episodeIds: ['episode:e1'] }],
    ['one episode id among garbage', { episodeIds: [42, 'not-an-episode', 'episode:e2'] }],
    ['non-empty evidence[]', { evidence: [{ kind: 'url', ref: 'https://x' }] }],
    ['evidence[] of malformed entries still counts (non-empty)', { evidence: [null] }],
    ['non-empty conversationId', { conversationId: 'conv-1' }],
    [
      'mention-path shape (vertical + conversationId)',
      { vertical: 'crm', conversationId: 'conv-9', recorder: 'gpt' },
    ],
  ];
  for (const [name, source] of GROUNDED) {
    it(`grounded: ${name}`, () => {
      expect(groundingStatusOf(source)).toBe('grounded');
    });
  }

  const UNGROUNDED: Array<[string, unknown]> = [
    ['bare source', { vertical: 'crm', recorder: 'agent' }],
    ['empty episodeIds', { episodeIds: [] }],
    ['non-prefixed episode ids only', { episodeIds: ['e1', 'turn:e2'] }],
    ['episodeIds not an array', { episodeIds: 'episode:e1' }],
    ['empty evidence[]', { evidence: [] }],
    ['evidence not an array', { evidence: { kind: 'url', ref: 'x' } }],
    ['empty conversationId', { conversationId: '' }],
    ['conversationId not a string', { conversationId: 42 }],
    ['null source', null],
    ['undefined source', undefined],
    ['array source', ['episode:e1']],
    ['string source', 'episode:e1'],
  ];
  for (const [name, source] of UNGROUNDED) {
    it(`ungrounded: ${name}`, () => {
      expect(groundingStatusOf(source)).toBe('ungrounded');
    });
  }
});

// ── The post-resolve stamp through the resolver ─────────────────────────

function makeResolver(outcome = 'INSERTED') {
  const queries: Array<{ sql: string; params: any }> = [];
  const db = {
    query: jest.fn(async (sql: string, params: any) => {
      queries.push({ sql, params });
      if (sql.includes('fn::resolve_facts')) {
        return [
          params.facts.map((f: any, i: number) => ({
            factId: outcome === 'REJECTED' ? null : `knowledge_fact:b${i}_${f.object}`,
            outcome,
          })),
        ];
      }
      if (sql.includes('fn::resolve_fact(')) {
        return [
          {
            factId: outcome === 'REJECTED' ? null : `knowledge_fact:single_${params.object}`,
            outcome,
          },
        ];
      }
      return [[]];
    }),
  };
  const factEmbedding = {
    embed: jest.fn(async () => [0.1]),
    writeAltEmbeddingIfHype: jest.fn(async () => {}),
  };
  const predicateRegistry = {
    getSnapshot: jest.fn(async () => ({})),
    policyFor: jest.fn((_c: string, p: string) => ({
      semantics: p === 'status' ? 'single_active' : 'append_only',
    })),
  };
  const svc = new FactResolverService(factEmbedding as never, predicateRegistry as never);
  return { svc, db, queries };
}

function input(predicate: string, object: string, source: unknown) {
  return {
    companyId: 'co_x',
    entityId: 'knowledge_entity:e1',
    predicate,
    object,
    confidence: 0.9,
    validFrom: new Date('2023-01-01T00:00:00Z'),
    source,
    precomputedEmbedding: [0.1, 0.2],
  };
}

const stampQ = (qs: Array<{ sql: string; params: any }>) =>
  qs.filter((q) => q.sql.includes('groundingStatus'));

describe('FactResolverService — grounding stamp (EVIDENCE_GROUNDING_STAMP)', () => {
  const saved = process.env.EVIDENCE_GROUNDING_STAMP;
  afterEach(() => {
    if (saved === undefined) delete process.env.EVIDENCE_GROUNDING_STAMP;
    else process.env.EVIDENCE_GROUNDING_STAMP = saved;
    jest.restoreAllMocks();
  });

  it('flag OFF (default): the db.query sequence is EXACTLY the resolver call — no stamp UPDATE', async () => {
    delete process.env.EVIDENCE_GROUNDING_STAMP;
    const { svc, db, queries } = makeResolver();
    await svc.resolveMany(db as never, [input('preference', 'a', {})]);
    // Byte-identity pin: one batched resolve, nothing else.
    expect(queries.map((q) => q.sql)).toEqual(['RETURN fn::resolve_facts($facts, $cfg)']);
    expect(stampQ(queries)).toHaveLength(0);
  });

  it('flag ON, batch path: one primary-key UPDATE per winner row with the computed status', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const { svc, db, queries } = makeResolver();
    await svc.resolveMany(db as never, [
      input('preference', 'a', {}), // bare → ungrounded
      input('intent', 'b', { conversationId: 'conv-1' }), // → grounded
    ]);
    const stamps = stampQ(queries);
    expect(stamps).toHaveLength(2);
    for (const s of stamps) {
      expect(s.sql).toBe('UPDATE $id SET groundingStatus = $status');
    }
    expect(stamps.map((s) => s.params.status)).toEqual(['ungrounded', 'grounded']);
    expect(String(stamps[0]!.params.id)).toBe('knowledge_fact:b0_a');
    expect(String(stamps[1]!.params.id)).toBe('knowledge_fact:b1_b');
  });

  it('flag ON, per-fact path (single_active): the winner row is stamped', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const { svc, db, queries } = makeResolver();
    await svc.resolve(db as never, input('status', 's', { evidence: [{ kind: 'url', ref: 'x' }] }));
    const stamps = stampQ(queries);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.params.status).toBe('grounded');
    expect(String(stamps[0]!.params.id)).toBe('knowledge_fact:single_s');
  });

  it('flag ON: REJECTED is never stamped', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const { svc, db, queries } = makeResolver('REJECTED');
    await svc.resolve(db as never, input('status', 's', {}));
    expect(stampQ(queries)).toHaveLength(0);
  });

  it('flag ON: CORROBORATED (standing row, no new row) is never stamped', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const { svc, db, queries } = makeResolver('CORROBORATED');
    await svc.resolve(db as never, input('status', 's', {}));
    expect(stampQ(queries)).toHaveLength(0);
  });

  it('flag ON: a stamp failure WARNs and never fails the ingest', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, db } = makeResolver();
    (db.query as jest.Mock).mockImplementation(async (sql: string, params: any) => {
      if (sql.includes('groundingStatus')) throw new Error('stamp down');
      if (sql.includes('fn::resolve_facts')) {
        return [
          params.facts.map((f: any, i: number) => ({
            factId: `knowledge_fact:b${i}`,
            outcome: 'INSERTED',
          })),
        ];
      }
      return [{ factId: 'knowledge_fact:s', outcome: 'INSERTED' }];
    });
    const out = await svc.resolveMany(db as never, [input('preference', 'a', {})]);
    expect(out[0]!.result.outcome).toBe('INSERTED');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('grounding-status stamp failed'));
  });
});
