/**
 * Pack-projected state deltas → belief promotion
 * (SCENES_PACK_DELTA_PROMOTION, default off).
 *
 * Covers the two independent reasons the pack projections were a write
 * with no reader, and the fences that must hold now that they are read:
 *  - the stateModelId → field mapping (packDeltaField), including the
 *    pack-namespacing rule and a stateModel that DECLARES its own field;
 *  - the promoter admission matrix (flag off ⇒ the selection query and
 *    its binds are byte-identical to the pre-flag pass; on ⇒ the pack
 *    worlds are admitted without an enrichmentVersion);
 *  - the per-user scope fence over pack scenes (#387 fail-closed);
 *  - the projected delta shape round-tripping into the fold;
 *  - the pack provenance stamp (promoterVersionFor) on the belief row.
 */
import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { SceneVersionService } from '../src/admin/scene-version';
import {
  BELIEF_PROMOTER_VERSION,
  BeliefPromotionService,
  buildPromotableScenesQuery,
  foldBeliefGroups,
  isPackSceneWorld,
  promoterVersionFor,
  sceneSingleUser,
  type PromotableSceneHead,
} from '../src/admin/belief-promotion.service';
import {
  packDeltaField,
  packSceneVersion,
  projectSceneDeltas,
  sceneScopeStamp,
} from '../src/documents/scene-candidate-writer.service';
import type { CandidateRow } from '../src/documents/candidate-store.service';
import {
  stateModelFieldLocal,
  validateMemoryModel,
  type DomainPackManifest,
} from '../src/ai/domain-packs';
import { scenePackDeltaPromotionEnabled } from '../src/common/scene-flags';

const PACK = 'realty_proj';
const OTHER_PACK = 'insurance_proj';

/** The manifest stateModels map the projector consumes. */
const models = (entries: Array<{ id: string; field?: string }>) =>
  new Map(entries.map((m) => [m.id, m]));

describe('packDeltaField (stateModelId → belief field)', () => {
  it('defaults to the stateModel id, pack-namespaced', () => {
    expect(packDeltaField(PACK, 'deal', models([{ id: 'deal' }]))).toBe('realty_proj__deal');
  });

  it('honours an explicitly declared stateModel field', () => {
    expect(
      packDeltaField(
        PACK,
        'deal_lifecycle',
        models([{ id: 'deal_lifecycle', field: 'deal_stage' }]),
      ),
    ).toBe('realty_proj__deal_stage');
  });

  it('treats a blank declared field as absent (falls back to the id)', () => {
    expect(packDeltaField(PACK, 'deal', models([{ id: 'deal', field: '   ' }]))).toBe(
      'realty_proj__deal',
    );
  });

  it.each([
    ['no manifest resolved (fail-open)', undefined],
    ['stateModelId absent from the manifest', models([{ id: 'other' }])],
  ])('degrades to the id for %s', (_name, m) => {
    expect(packDeltaField(PACK, 'deal', m)).toBe('realty_proj__deal');
  });

  it('keeps two packs whose stateModels resolve to the SAME local field distinct', () => {
    const a = packDeltaField(PACK, 'lifecycle', models([{ id: 'lifecycle', field: 'status' }]));
    const b = packDeltaField(
      OTHER_PACK,
      'lifecycle',
      models([{ id: 'lifecycle', field: 'status' }]),
    );
    expect(a).toBe('realty_proj__status');
    expect(b).toBe('insurance_proj__status');
    // The whole point of the rule: no silent merge into one belief group.
    expect(a).not.toBe(b);
  });

  it('stateModelFieldLocal defaults to the id and never invents a namespace', () => {
    expect(stateModelFieldLocal({ id: 'listing_lifecycle' })).toBe('listing_lifecycle');
    expect(stateModelFieldLocal({ id: 'listing_lifecycle', field: 'listing_status' })).toBe(
      'listing_status',
    );
  });
});

describe('manifest validation of the optional stateModel field', () => {
  // Deliberately untyped shapes: the point is what a THIRD-PARTY manifest
  // may carry, which is exactly what the validator exists to reject.
  const pack = (field: unknown): DomainPackManifest =>
    ({
      id: 'p1',
      version: '1.0.0',
      description: 'x',
      predicates: [],
      memoryModel: {
        stateModels: [
          {
            id: 'deal',
            subjectType: 'deal',
            states: ['open', 'closed'],
            ...(field === undefined ? {} : { field }),
          },
        ],
      },
    }) as unknown as DomainPackManifest;

  it('accepts a manifest that omits field (every shipped pack)', () => {
    const p = pack(undefined);
    expect(() => validateMemoryModel(p, p.memoryModel)).not.toThrow();
  });

  it('accepts a declared snake_case field', () => {
    const p = pack('deal_stage');
    expect(() => validateMemoryModel(p, p.memoryModel)).not.toThrow();
  });

  it.each([
    ['a namespace separator', 'deal__stage'],
    ['upper case', 'DealStage'],
    ['a non-string', 42],
  ])('rejects %s', (_name, bad) => {
    const p = pack(bad);
    expect(() => validateMemoryModel(p, p.memoryModel)).toThrow(/stateModel "deal" field/);
  });
});

describe('buildPromotableScenesQuery (admission matrix)', () => {
  // The pre-flag query, verbatim. Pinning the STRING is the point: the
  // default-off promise is "byte-identical", not "equivalent".
  const HISTORICAL = `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas,
                enrichedMemoryValue.explicitness AS explicitness
           FROM memory_episode
          WHERE segmenterVersion = $v AND enrichmentVersion IS NOT NONE`;

  it('flag off ⇒ the historical SQL and binds, byte for byte', () => {
    expect(
      buildPromotableScenesQuery({ version: 'scene-segmenter-v1', packDeltas: false }),
    ).toEqual({ sql: HISTORICAL, params: { v: 'scene-segmenter-v1' } });
  });

  it('flag off + conversation scope ⇒ the historical conversation clause', () => {
    const q = buildPromotableScenesQuery({
      version: 'scene-segmenter-v1',
      conversationId: 'conv:a',
      packDeltas: false,
    });
    expect(q.sql).toBe(`${HISTORICAL} AND conversationIds CONTAINS $conv`);
    expect(q.params).toEqual({ v: 'scene-segmenter-v1', conv: 'conv:a' });
  });

  it('flag off ⇒ no pack leg, no pack bind, no segmenterVersion projection', () => {
    const q = buildPromotableScenesQuery({ version: 'scene-segmenter-v1', packDeltas: false });
    expect(q.sql).not.toContain('pack');
    expect(q.sql).not.toContain('segmenterVersion,');
    expect(q.params).not.toHaveProperty('packPrefix');
  });

  it('flag on ⇒ pack worlds admitted WITHOUT an enrichmentVersion, world projected', () => {
    const q = buildPromotableScenesQuery({ version: 'scene-segmenter-v1', packDeltas: true });
    // The composer leg is untouched — pack admission is purely additive.
    expect(q.sql).toContain('segmenterVersion = $v AND enrichmentVersion IS NOT NONE');
    expect(q.sql).toContain('string::starts_with(segmenterVersion, $packPrefix)');
    expect(q.sql).toContain('array::len(stateDeltas) > 0');
    // The world rides back so the belief can carry the pack provenance.
    expect(q.sql).toContain('stateDeltas, segmenterVersion,');
    expect(q.params).toEqual({ v: 'scene-segmenter-v1', packPrefix: 'pack:' });
  });

  it('flag on + conversation scope keeps the conversation clause outside the OR', () => {
    const q = buildPromotableScenesQuery({
      version: 'scene-segmenter-v1',
      conversationId: 'conv:a',
      packDeltas: true,
    });
    expect(q.sql.trimEnd().endsWith('AND conversationIds CONTAINS $conv')).toBe(true);
  });

  it('the pack world prefix matches what the projector stamps', () => {
    expect(isPackSceneWorld(packSceneVersion(PACK, '1.0.0'))).toBe(true);
    expect(isPackSceneWorld('scene-segmenter-v1+abcdef12')).toBe(false);
  });
});

describe('SCENES_PACK_DELTA_PROMOTION resolver + service seam', () => {
  const saved = process.env.SCENES_PACK_DELTA_PROMOTION;
  const savedPromotion = process.env.SCENES_BELIEF_PROMOTION;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCENES_PACK_DELTA_PROMOTION;
    else process.env.SCENES_PACK_DELTA_PROMOTION = saved;
    if (savedPromotion === undefined) delete process.env.SCENES_BELIEF_PROMOTION;
    else process.env.SCENES_BELIEF_PROMOTION = savedPromotion;
  });

  it('defaults off', () => {
    delete process.env.SCENES_PACK_DELTA_PROMOTION;
    expect(scenePackDeltaPromotionEnabled()).toBe(false);
    process.env.SCENES_PACK_DELTA_PROMOTION = '1';
    expect(scenePackDeltaPromotionEnabled()).toBe(true);
  });

  /** A promotion service whose db records every query and returns nothing. */
  function makeService(): { svc: BeliefPromotionService; sql: string[] } {
    const sql: string[] = [];
    const db = {
      query: (q: string) => {
        sql.push(q);
        return Promise.resolve([[]]);
      },
    };
    const surreal = {
      withCompany: <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
    } as unknown as SurrealService;
    const versions = {
      resolve: () => ({ version: 'scene-segmenter-v1' }),
    } as unknown as SceneVersionService;
    const config = { get: (_k: string, def?: string) => def } as unknown as ConfigService;
    return { svc: new BeliefPromotionService(surreal, config, versions), sql };
  }

  it('flag off ⇒ the pass issues exactly the historical selection', async () => {
    process.env.SCENES_BELIEF_PROMOTION = '1';
    delete process.env.SCENES_PACK_DELTA_PROMOTION;
    const { svc, sql } = makeService();
    await svc.run('co_test');
    expect(sql).toHaveLength(1);
    expect(sql[0]).toBe(
      buildPromotableScenesQuery({ version: 'scene-segmenter-v1', packDeltas: false }).sql,
    );
  });

  it('flag on ⇒ the pass issues the widened selection', async () => {
    process.env.SCENES_BELIEF_PROMOTION = '1';
    process.env.SCENES_PACK_DELTA_PROMOTION = '1';
    const { svc, sql } = makeService();
    await svc.run('co_test');
    expect(sql[0]).toBe(
      buildPromotableScenesQuery({ version: 'scene-segmenter-v1', packDeltas: true }).sql,
    );
  });
});

describe('promoterVersionFor (pack provenance without a new column)', () => {
  const RUN = `${BELIEF_PROMOTER_VERSION}|scene-segmenter-v1`;
  const packWorld = packSceneVersion(PACK, '1.0.0');

  it.each([
    ['no worlds (flag off — the column is not selected)', [] as string[]],
    ['a composer world', ['scene-segmenter-v1']],
    ['a MIXED set (belongs to neither plane alone)', ['scene-segmenter-v1', packWorld]],
  ])('keeps the run stamp for %s', (_name, worlds) => {
    expect(promoterVersionFor({ worlds }, RUN)).toBe(RUN);
  });

  it('stamps the pack world when the belief came wholly out of one pack', () => {
    expect(promoterVersionFor({ worlds: [packWorld] }, RUN)).toBe(
      `${BELIEF_PROMOTER_VERSION}|${packWorld}`,
    );
  });
});

describe('projected delta shape round-trips into the fold', () => {
  const deltaRow = (over: Partial<CandidateRow['payload']> = {}): CandidateRow => ({
    id: 'candidate:d1',
    runId: 'run1',
    chunkSeq: 0,
    kind: 'state_delta',
    confidence: 0.8,
    status: 'pending',
    payload: {
      sceneIndex: 0,
      stateModelId: 'deal',
      subject: 'the Elm St purchase',
      from: 'open',
      to: 'under_offer',
      ...over,
    },
  });

  const projected = projectSceneDeltas({
    deltas: [deltaRow()],
    sceneIndex: 0,
    packId: PACK,
    models: models([{ id: 'deal' }]),
  });

  it('writes BOTH stateModelId (pack provenance) and field (belief key)', () => {
    expect(projected).toEqual([
      {
        stateModelId: 'deal',
        field: 'realty_proj__deal',
        subject: 'the Elm St purchase',
        from: 'open',
        to: 'under_offer',
        confidence: 0.8,
        candidateId: 'candidate:d1',
      },
    ]);
  });

  it('only projects the deltas of the requested scene index', () => {
    expect(
      projectSceneDeltas({
        deltas: [deltaRow({ sceneIndex: 1 })],
        sceneIndex: 0,
        packId: PACK,
        models: models([{ id: 'deal' }]),
      }),
    ).toEqual([]);
  });

  const packScene = (over: Partial<PromotableSceneHead> = {}): PromotableSceneHead => ({
    id: 'memory_episode:pack1',
    ...sceneScopeStamp({ userId: 'u_pack' }),
    conversationIds: [],
    occurredTo: '2026-09-01T11:00:00.000Z',
    segmenterVersion: packSceneVersion(PACK, '1.0.0'),
    stateDeltas: projected,
    ...over,
  });

  it('folds the projected shape into one belief carrying the pack field + world', () => {
    const { folded, conflicts } = foldBeliefGroups([{ userId: 'u_pack', scene: packScene() }]);
    expect(conflicts).toEqual([]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      userId: 'u_pack',
      subject: 'the Elm St purchase',
      field: 'realty_proj__deal',
      value: 'under_offer',
      priorValue: 'open',
      worlds: [packSceneVersion(PACK, '1.0.0')],
    });
    // No conversation backs a document scene — the distinct-CONVERSATION
    // floor therefore excludes pack beliefs whenever it is non-zero.
    expect(folded[0]!.conversationIds).toEqual([]);
  });

  it('a pre-mapping delta (stateModelId only, no field) is still dropped', () => {
    const legacy = projected.map(({ field: _drop, ...rest }) => rest);
    const { folded } = foldBeliefGroups([
      { userId: 'u_pack', scene: packScene({ stateDeltas: legacy }) },
    ]);
    expect(folded).toEqual([]);
  });
});

describe('per-user scope fence over pack-projected scenes (#387)', () => {
  const world = packSceneVersion(PACK, '1.0.0');
  const scene = (over: Partial<PromotableSceneHead>): PromotableSceneHead => ({
    id: 'memory_episode:pack1',
    conversationIds: [],
    occurredTo: '2026-09-01T11:00:00.000Z',
    segmenterVersion: world,
    stateDeltas: [{ field: 'realty_proj__deal', subject: 's', from: 'open', to: 'under_offer' }],
    ...over,
  });

  it('a user-scoped document projects scenes that admit exactly that user', () => {
    expect(sceneSingleUser(scene(sceneScopeStamp({ userId: 'u_a' })))).toBe('u_a');
  });

  it('a TENANT-GLOBAL document projects scenes that promote for NO ONE', () => {
    // sceneScopeStamp of a doc without a user = { scope: [] } — no
    // userIds, so the fail-closed fence refuses it.
    expect(sceneSingleUser(scene(sceneScopeStamp({})))).toBeNull();
  });

  it.each([
    ['a mixed member set', { userId: 'u_a', userIds: ['u_a', 'u_b'] }],
    ['a userId disagreeing with the member set', { userId: 'u_b', userIds: ['u_a'] }],
    ['legacy rows without userIds', { userId: 'u_a' }],
  ])('never promotes a pack scene with %s', (_name, over) => {
    expect(sceneSingleUser(scene(over))).toBeNull();
  });

  it("a pack scene of user A can never land in user B's beliefs", () => {
    const { folded } = foldBeliefGroups([
      {
        userId: 'u_a',
        scene: scene({ id: 'memory_episode:a', ...sceneScopeStamp({ userId: 'u_a' }) }),
      },
      {
        userId: 'u_b',
        scene: scene({
          id: 'memory_episode:b',
          ...sceneScopeStamp({ userId: 'u_b' }),
          stateDeltas: [{ field: 'realty_proj__deal', subject: 's', from: 'open', to: 'closed' }],
        }),
      },
    ]);
    // Same (subject, field), two users ⇒ two beliefs, never one merged
    // group and never a conflict between strangers.
    expect(folded.map((f) => [f.userId, f.value])).toEqual([
      ['u_a', 'under_offer'],
      ['u_b', 'closed'],
    ]);
  });
});
