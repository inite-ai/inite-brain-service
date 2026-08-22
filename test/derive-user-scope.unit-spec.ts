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
    const [row] = build([[1]]);
    expect(row.userId).toBeUndefined();
    expect(row.crossUserScope).toBe(false);
  });

  it("grounded in one user's turns (global ride-along ok) → that user's row", () => {
    const [own, mixed] = build([[0], [0, 1]]);
    expect(own.userId).toBe('user-a');
    expect(own.crossUserScope).toBe(false);
    expect(mixed.userId).toBe('user-a');
    expect(mixed.crossUserScope).toBe(false);
  });

  it('grounded in turns of two users → poisoned for any scope (crossUserScope)', () => {
    const [row] = build([[0, 2]]);
    expect(row.userId).toBeUndefined();
    expect(row.crossUserScope).toBe(true);
  });

  it('empty turns → invalid grounding, never a tenant-global fact (round 3)', () => {
    const [row] = build([[]]);
    expect(row.groundingInvalid).toBe(true);
    expect(row.userId).toBeUndefined();
  });

  it('a negative index poisons the whole proposition', () => {
    const [row] = build([[-1, 1]]);
    expect(row.groundingInvalid).toBe(true);
  });

  it('an out-of-range index poisons the whole proposition', () => {
    const [row] = build([[1, 99]]);
    expect(row.groundingInvalid).toBe(true);
  });

  it('fully valid grounding stays valid', () => {
    const [row] = build([[0, 1]]);
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
    expect(pool[0].entityId).toBe('knowledge_entity:alice');
  });
});
