/**
 * Release blocker (audit 2026-08-21 P0): the per-user scope of the
 * grounding turns must survive derivation. Pins the scope rule of
 * buildDerivedRows (global / single-user / cross-user) and the
 * rollup-pool exclusion of user-scoped rows in accumulateLanded.
 */
import { buildDerivedRows } from '../src/admin/derive-row-builder';
import { accumulateLanded, type RollupMember } from '../src/admin/aspect-rollups';
import type { EpisodeRow } from '../src/episodes/session-window';
import type { DerivedProposition } from '../src/admin/deriver-client';

const SESSION: EpisodeRow[] = [
  {
    id: 'episode:a0',
    speaker: 'Alice',
    text: 'my private plan',
    occurredAt: '2026-08-01T10:00:00Z',
    userId: 'user-a',
  },
  {
    id: 'episode:g1',
    speaker: 'Bot',
    text: 'a tenant-global turn',
    occurredAt: '2026-08-01T10:01:00Z',
  },
  {
    id: 'episode:b2',
    speaker: 'Bob',
    text: 'my other private plan',
    occurredAt: '2026-08-01T10:02:00Z',
    userId: 'user-b',
  },
] as EpisodeRow[];

const NS = { final: 'wd-t', staging: 'wd-t.staging' } as never;

function prop(turns: number[]): DerivedProposition {
  return {
    subject: 'Alice',
    aspect: 'plans',
    proposition: 'a derived plan',
    occurred_on: null,
    turns,
  } as DerivedProposition;
}

function build(turnsPerProp: number[][]) {
  return buildDerivedRows({
    resolved: turnsPerProp.map((turns) => ({
      p: prop(turns),
      entityId: 'knowledge_entity:alice',
    })),
    vectors: turnsPerProp.map(() => [1, 0]),
    sessionDate: new Date('2026-08-01T00:00:00Z'),
    session: SESSION,
    ns: NS,
    conversationId: 'conv-1',
  });
}

describe('derive user scope (audit 2026-08-21 P0)', () => {
  it('grounded only in global turns → tenant-global row', () => {
    const row = build([[1]])[0]!;
    expect(row.userId).toBeUndefined();
    expect(row.crossUserScope).toBe(false);
  });

  it("grounded in one user's turns (global ride-along ok) → that user's row", () => {
    const scoped = build([[0], [0, 1]]);
    const own = scoped[0]!;
    const mixed = scoped[1]!;
    expect(own.userId).toBe('user-a');
    expect(own.crossUserScope).toBe(false);
    expect(mixed.userId).toBe('user-a');
    expect(mixed.crossUserScope).toBe(false);
  });

  it('grounded in turns of two users → poisoned for any scope (crossUserScope)', () => {
    const row = build([[0, 2]])[0]!;
    expect(row.userId).toBeUndefined();
    expect(row.crossUserScope).toBe(true);
  });

  it('empty turns → invalid grounding, never a tenant-global fact (round 3)', () => {
    const row = build([[]])[0]!;
    expect(row.groundingInvalid).toBe(true);
    expect(row.userId).toBeUndefined();
  });

  it('a negative index poisons the whole proposition', () => {
    const row = build([[-1, 1]])[0]!;
    expect(row.groundingInvalid).toBe(true);
  });

  it('an out-of-range index poisons the whole proposition', () => {
    const row = build([[1, 99]])[0]!;
    expect(row.groundingInvalid).toBe(true);
  });

  it('fully valid grounding stays valid', () => {
    const row = build([[0, 1]])[0]!;
    expect(row.groundingInvalid).toBe(false);
    expect(row.userId).toBe('user-a');
  });

  it('rollup/compose pools never accept user-scoped rows', () => {
    const rows = build([[1], [0]]);
    const pool: RollupMember[] = [];
    accumulateLanded(pool, rows, {
      outcomes: rows.map(() => ({ outcome: 'INSERTED' })),
    });
    expect(pool).toHaveLength(1);
    expect(pool[0]!.entityId).toBe('knowledge_entity:alice');
  });
});

/**
 * G3 char-span grounding quotes (DERIVER_SPANS): rows carry
 * source.charSpans ONLY when the flag is on AND a quote mechanically
 * verifies against its grounding turn's stored text; everything else
 * (flag off, absent quote, failed verification) keeps the source shape
 * byte-identical to today.
 */
describe('char-span grounding quotes (G3, DERIVER_SPANS)', () => {
  const OLD = process.env.DERIVER_SPANS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.DERIVER_SPANS;
    else process.env.DERIVER_SPANS = OLD;
  });

  function buildQuoted(turns: number[], quotes: Array<string | null> | undefined) {
    return buildDerivedRows({
      resolved: [
        {
          p: { ...prop(turns), ...(quotes !== undefined ? { quotes } : {}) },
          entityId: 'knowledge_entity:alice',
        },
      ],
      vectors: [[1, 0]],
      sessionDate: new Date('2026-08-01T00:00:00Z'),
      session: SESSION,
      ns: NS,
      conversationId: 'conv-1',
    });
  }

  it('flag on: a verifying quote lands as source.charSpans with offsets', () => {
    process.env.DERIVER_SPANS = '1';
    // SESSION[1].text = 'a tenant-global turn'
    const row = buildQuoted([1], ['tenant-global'])[0]!;
    expect(row.source.charSpans).toEqual([
      {
        episodeId: 'episode:g1',
        start: 2,
        end: 15,
        exact: 'tenant-global',
        prefix: 'a ',
        suffix: ' turn',
      },
    ]);
  });

  it('flag on: an unverifiable quote drops silently, the fact still lands', () => {
    process.env.DERIVER_SPANS = '1';
    const row = buildQuoted([1], ['never said this'])[0]!;
    expect(row.source).not.toHaveProperty('charSpans');
    expect(row.object).toBe('a derived plan');
    expect(row.groundingInvalid).toBe(false);
  });

  it('flag on: null quote entries contribute no span', () => {
    process.env.DERIVER_SPANS = '1';
    const row = buildQuoted([0, 1], [null, 'tenant-global'])[0]!;
    expect(row.source.charSpans).toHaveLength(1);
    expect((row.source.charSpans as Array<{ episodeId: string }>)[0]!.episodeId).toBe('episode:g1');
  });

  it('flag off: quotes are ignored — source shape is byte-identical', () => {
    delete process.env.DERIVER_SPANS;
    const row = buildQuoted([1], ['tenant-global'])[0]!;
    expect(row.source).not.toHaveProperty('charSpans');
  });
});
