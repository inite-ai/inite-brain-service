/**
 * Belief revision chain against a REAL SurrealDB — the two clocks of a
 * belief (audit 2026-09-06 F6) and the compare-and-set revision write.
 *
 * validFrom is when the state BEGAN; latestEvidenceAt (0137) is the
 * WATERMARK — the latest scene the belief has processed. Targeted
 * promotion by conversation, one scene per run, in EVERY order of
 * {A on Jan 1, B on Feb 1, A on Mar 1}: the active row must come out
 * the same — A since March, displacing B — whatever order the runs saw
 * the scenes. Before the fix the order A, A, B ended with B active (the
 * audit's repro): the stale guard compared B's date against the state's
 * beginning (Jan 1) instead of the latest evidence (Mar 1).
 *
 * Concurrency: two runs revising one key at once leave exactly one
 * active head, and a revision slot another writer filled with a
 * different value is never overwritten — the loser writes nothing.
 *
 * Scene rows are seeded directly (the belief-promotion.e2e precedent):
 * hand-seeded rows make the chain deterministic.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { Logger } from '@nestjs/common';
import {
  BeliefPromotionService,
  beliefIdTail,
  type FoldedBelief,
} from '../src/admin/belief-promotion.service';
import { commitRevision } from '../src/admin/belief-revision';

interface BeliefRow {
  id: unknown;
  userId: string;
  subject: string;
  field: string;
  value: string;
  priorValue?: string;
  revision: number;
  status: string;
  supersededBy?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  latestEvidenceAt?: unknown;
  corroborationCount?: number;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

const JAN = '2026-01-01T00:00:00.000Z';
const FEB = '2026-02-01T00:00:00.000Z';
const MAR = '2026-03-01T00:00:00.000Z';
const APR = '2026-04-01T00:00:00.000Z';

interface Evt {
  tag: string;
  at: string;
  value: string;
}
const EVENTS: Evt[] = [
  { tag: 'a1', at: JAN, value: 'A' },
  { tag: 'b2', at: FEB, value: 'B' },
  { tag: 'a3', at: MAR, value: 'A' },
];
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

describe('belief revision chain: two clocks + compare-and-set (e2e)', () => {
  let f: AppFixture;
  const saved: Record<string, string | undefined> = {};
  const FLAGS = [
    'SCENES_SEGMENTATION_ENABLED',
    'SCENES_BELIEF_PROMOTION',
    'SCENES_BELIEF_MIN_SCENES',
    'SCENES_BELIEF_LLM_SYNTHESIS',
    'SCENES_BELIEF_NEGATION_DELTAS',
    'SCENES_BELIEF_FIELD_FOLD',
    'SCENES_VALUE_GATE_ENABLED',
    'PROVENANCE_SUPPORT_EDGES',
  ];

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const seedScene = async (o: {
    tail: string;
    user: string;
    conv: string;
    at: string;
    value: string;
    from?: string;
  }): Promise<void> => {
    await db(async (d) => {
      await d.query(
        `CREATE type::record('memory_episode', $tail) CONTENT {
           userId: $user, userIds: [$user], scope: [], sceneLabel: 'seed',
           conversationIds: [$conv], occurredFrom: <datetime>$at, occurredTo: <datetime>$at,
           gist: 'seed gist', confidence: 1,
           stateDeltas: [{ subject: 'alice', field: 'city', from: $from, to: $value }],
           segmenterVersion: 'scene-segmenter-v1', generation: 'seed-gen',
           source: { recorder: 'test-seed' },
           enrichmentVersion: 'seed-enrich-v1', enrichedMemoryValue: { explicitness: 0.8 }
         }`,
        {
          tail: o.tail,
          user: o.user,
          conv: o.conv,
          at: o.at,
          value: o.value,
          from: o.from ?? '',
        },
      );
    });
  };

  const promoteConv = (conv: string) =>
    f.app.get(BeliefPromotionService).run(f.companyId, { conversationId: conv });

  const chainOf = (user: string): Promise<BeliefRow[]> =>
    db(async (d) => {
      const [rows] = await d.query<[BeliefRow[]]>(
        `SELECT * FROM semantic_belief WHERE userId = $u ORDER BY revision ASC`,
        { u: user },
      );
      return rows ?? [];
    });

  beforeAll(async () => {
    for (const k of FLAGS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_BELIEF_PROMOTION = '1';
    f = await createApp({ companyId: 'co_belief_chain_e2e' });
  }, 120000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it.each(permutations(EVENTS).map((order) => [order.map((e) => e.tag).join(','), order]))(
    'arrival order %s converges to A since March, displacing B',
    async (label, order) => {
      const user = `perm_${(label as string).replace(/,/g, '_')}`;
      for (const e of order as Evt[]) {
        const conv = `${user}:${e.tag}`;
        await seedScene({ tail: `${user}_${e.tag}`, user, conv, at: e.at, value: e.value });
        await promoteConv(conv);
      }
      const chain = await chainOf(user);
      const active = chain.filter((r) => r.status === 'active');
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ value: 'A', priorValue: 'B' });
      expect(iso(active[0]!.validFrom)).toBe(MAR);
      expect(iso(active[0]!.latestEvidenceAt)).toBe(MAR);
      // The chain is 1..n without gaps and every displaced row points forward.
      expect(chain.map((r) => r.revision)).toEqual(chain.map((_, i) => i + 1));
      for (const r of chain.filter((r) => r.status === 'superseded')) {
        expect(r.supersededBy).toBeDefined();
        expect(r.validUntil).toBeDefined();
      }
    },
  );

  it('a confirmation advances the watermark and leaves the beginning alone; the late B is not a revision', async () => {
    const user = 'wm_user';
    await seedScene({ tail: 'wm_a1', user, conv: 'wm:c1', at: JAN, value: 'A' });
    expect(await promoteConv('wm:c1')).toMatchObject({ beliefsCreated: 1 });
    await seedScene({ tail: 'wm_a3', user, conv: 'wm:c3', at: MAR, value: 'A' });
    expect(await promoteConv('wm:c3')).toMatchObject({ beliefsCorroborated: 1, beliefsRevised: 0 });
    let [head] = await chainOf(user);
    expect(head).toMatchObject({ value: 'A', revision: 1, corroborationCount: 2 });
    expect(iso(head!.validFrom)).toBe(JAN); // the beginning stays
    expect(iso(head!.latestEvidenceAt)).toBe(MAR); // the watermark moved

    // B dated between the two confirmations arrives last: no revision —
    // the chain reads A · B · A, so A holds and merely began again in March.
    await seedScene({ tail: 'wm_b2', user, conv: 'wm:c2', at: FEB, value: 'B' });
    const late = await promoteConv('wm:c2');
    expect(late).toMatchObject({ beliefsRevised: 0, beliefsCreated: 0, beliefsRealigned: 1 });
    const chain = await chainOf(user);
    expect(chain).toHaveLength(1);
    [head] = chain;
    expect(head).toMatchObject({ value: 'A', priorValue: 'B', status: 'active' });
    expect(iso(head!.validFrom)).toBe(MAR);
  });

  it('a legacy row without a watermark is judged by its validFrom, then stamped on its next corroboration', async () => {
    const user = 'legacy_user';
    // A pre-0137 revision: validFrom only, no latestEvidenceAt.
    await db(async (d) => {
      await d.query(
        `CREATE type::record('semantic_belief', $tail) CONTENT {
           userId: $u, subject: 'alice', field: 'city', value: 'A',
           statement: 'alice — city: A', statementSource: 'template', confidence: 0.8,
           revision: 1, status: 'active', validFrom: <datetime>$from,
           sourceSceneIds: [], conversationIds: [], corroborationCount: 1, conversationCount: 1,
           promoterVersion: 'belief-promotion-v1'
         }`,
        {
          tail: beliefIdTail({ userId: user, subject: 'alice', field: 'city' }, 1),
          u: user,
          from: MAR,
        },
      );
    });
    await seedScene({ tail: 'lg_b2', user, conv: 'lg:c2', at: FEB, value: 'B' });
    expect(await promoteConv('lg:c2')).toMatchObject({ skippedStale: 1, beliefsRevised: 0 });
    expect(await chainOf(user)).toHaveLength(1);

    await seedScene({ tail: 'lg_a4', user, conv: 'lg:c4', at: APR, value: 'A' });
    expect(await promoteConv('lg:c4')).toMatchObject({ beliefsCorroborated: 1 });
    const [head] = await chainOf(user);
    expect(iso(head!.latestEvidenceAt)).toBe(APR);
    expect(iso(head!.validFrom)).toBe(MAR); // no interlude after March — kept
  });

  it('two concurrent runs revising one key leave exactly one active head', async () => {
    const user = 'race_user';
    await seedScene({ tail: 'rc_a', user, conv: 'rc:c0', at: JAN, value: 'A' });
    expect(await promoteConv('rc:c0')).toMatchObject({ beliefsCreated: 1 });
    await seedScene({ tail: 'rc_b', user, conv: 'rc:c1', at: FEB, value: 'B' });
    await seedScene({ tail: 'rc_c', user, conv: 'rc:c2', at: MAR, value: 'C' });
    const results = await Promise.all([promoteConv('rc:c1'), promoteConv('rc:c2')]);
    // Both runs fold the same chain (A · B · C) and race for revision 2 = C:
    // exactly one lands it; the other either loses the compare-and-set
    // (contended) or, having run second, finds the head already at C.
    expect(results.reduce((n, r) => n + r.beliefsRevised, 0)).toBe(1);
    const chain = await chainOf(user);
    expect(chain.map((r) => `${r.revision}:${r.value}:${r.status}`)).toEqual([
      '1:A:superseded',
      '2:C:active',
    ]);
    expect(String(chain[0]!.supersededBy)).toBe(String(chain[1]!.id));
  });

  it('a revision slot another writer filled with a different value is never overwritten', async () => {
    const user = 'slot_user';
    await seedScene({ tail: 'sl_a', user, conv: 'sl:c0', at: JAN, value: 'A' });
    expect(await promoteConv('sl:c0')).toMatchObject({ beliefsCreated: 1 });
    const [head] = await chainOf(user);
    const key = { userId: user, subject: 'alice', field: 'city' };
    const candidate = (value: string): FoldedBelief => ({
      ...key,
      value,
      priorValue: 'A',
      displacedValue: 'A',
      displacedAt: new Date(JAN),
      validFrom: new Date(FEB),
      evidenceAt: new Date(FEB),
      runEvidenceAt: [new Date(FEB)],
      sceneIds: [],
      allSceneIds: [],
      conversationIds: [],
      confidence: 0.8,
      worlds: [],
    });
    // The compare-and-set, driven directly: two writers, two values, one
    // revision slot — on two separate pool connections.
    const logger = new Logger('belief-revision-chain.e2e');
    const displaced = { id: String(head!.id), revision: 1, until: new Date(FEB) };
    const commit = (value: string) =>
      db((d) =>
        commitRevision({
          db: d,
          belief: candidate(value),
          revision: 2,
          promoterVersion: 'belief-promotion-v1',
          statement: { text: `alice — city: ${value} (was: A)`, source: 'template' },
          displaced,
          logger,
        }),
      );
    const [x, y] = await Promise.all([commit('X'), commit('Y')]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const chain = await chainOf(user);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ revision: 1, status: 'superseded' });
    expect(chain[1]).toMatchObject({ revision: 2, status: 'active' });
    const winner = chain[1]!.value;
    expect(['X', 'Y']).toContain(winner);
    // The loser, retried after the fact, still writes nothing: the slot
    // holds another value and the head is no longer active.
    const loser = winner === 'X' ? 'Y' : 'X';
    expect(await commit(loser)).toBe(false);
    expect((await chainOf(user)).map((r) => `${r.revision}:${r.value}:${r.status}`)).toEqual([
      '1:A:superseded',
      `2:${winner}:active`,
    ]);
  });
});
