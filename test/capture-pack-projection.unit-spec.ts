/**
 * Capture-path pack memory projections (0110,
 * PACK_MEMORY_PROJECTIONS_ENABLED) — the mention-origin producer:
 *
 *  1. the SHARED write shape (pack-scene-projection.ts): a document-origin
 *     and a capture-origin row are the same row modulo provenance, with
 *     the same 0055/0093/0117 scope stamping and the same id mold;
 *  2. derivePackScenes: the model-free reader of a pack's declared
 *     perception — literal cues fire scenes, declared states become
 *     advisory deltas, and a pack that declared nothing matchable stays
 *     silent;
 *  3. MentionProjectionService: the flag-off byte-identical no-op, the
 *     no-packs early exit, per-(turn, pack, schema) idempotency, the L0
 *     membership edge that GDPR erasure rides, and the soft-fail posture.
 */
import { RecordId, StringRecordId } from 'surrealdb';
import {
  PACK_SCENE_PROJECTOR,
  buildPackSceneRow,
  packSceneIdTail,
  packSceneProjectionName,
  packSceneScopeStamp,
  packSceneVersion,
  packStateDeltaEntry,
  packDeltaField,
  packStateModelIndex,
} from '../src/episodes/pack-scene-projection';
import { sceneScopeStamp } from '../src/documents/scene-candidate-writer.service';
import { derivePackScenes } from '../src/ingest/pack-scene-derivation';
import { MentionProjectionService } from '../src/ingest/mention-projection.service';
import type { PackMemoryModelBinding } from '../src/ai/memory-model-reader.service';
import type { MemoryModelReaderService } from '../src/ai/memory-model-reader.service';
import type { ProjectionRegistryService } from '../src/episodes/projection-registry.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { PackMemoryModel } from '../src/ai/domain-packs/manifest';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

const PACK_ID = 'realty';
const PACK_VERSION = '1.0.0';
const EPISODE_ID = 'episode:turn1';

const MODEL: PackMemoryModel = {
  sceneSchemas: [
    { id: 'viewing', description: 'A property viewing.', cues: ['viewing', 'open house'] },
    { id: 'closing', description: 'A closing.', cues: ['escrow'] },
    { id: 'silent', description: 'Never fires — no cues declared.' },
  ],
  stateModels: [
    {
      id: 'listing_lifecycle',
      subjectType: 'listing',
      states: ['listed', 'under_offer', 'sold', 'let'],
      transitions: [{ from: 'listed', to: 'under_offer' }],
    },
  ],
};

const BINDING: PackMemoryModelBinding = {
  packId: PACK_ID,
  packVersion: PACK_VERSION,
  memoryModel: MODEL,
};

// ── 1. the shared write shape ────────────────────────────────────────────

describe('pack scene projection — one shape, two origins', () => {
  const common = {
    sceneLabel: 'viewing · viewing',
    conversationIds: [],
    occurredFrom: new Date('2026-09-01T10:00:00.000Z'),
    occurredTo: new Date('2026-09-01T10:00:00.000Z'),
    gist: 'Client toured 12 Elm St.',
    confidence: 0.6,
    version: packSceneVersion(PACK_ID, PACK_VERSION),
    generation: '2026-09-01T10:00:01.000Z',
    stateDeltas: [],
  };

  it('writes the same row from a document origin and a capture origin', () => {
    const docRow = buildPackSceneRow({
      ...common,
      idTail: packSceneIdTail('source_document:d1', common.version, 0),
      origin: { docId: new StringRecordId('source_document:d1'), packId: PACK_ID },
    });
    const turnRow = buildPackSceneRow({
      ...common,
      idTail: packSceneIdTail(EPISODE_ID, common.version, 'viewing'),
      origin: { episodeId: new StringRecordId(EPISODE_ID), packId: PACK_ID },
    });
    // Same table columns, same order, same types — only the id and the
    // provenance under `source` differ.
    expect(Object.keys(turnRow)).toEqual(Object.keys(docRow));
    expect(Object.keys(turnRow)).toEqual([
      'id',
      'scope',
      'sceneLabel',
      'conversationIds',
      'occurredFrom',
      'occurredTo',
      'gist',
      'confidence',
      'segmenterVersion',
      'generation',
      'source',
      'stateDeltas',
    ]);
    for (const row of [docRow, turnRow]) {
      expect((row.source as Record<string, unknown>).recorder).toBe(PACK_SCENE_PROJECTOR);
      expect(row.segmenterVersion).toBe(common.version);
      expect(row.id).toBeInstanceOf(RecordId);
    }
  });

  it('stamps the 0055/0093/0117 scope fold identically for both origins', () => {
    expect(packSceneScopeStamp('u1')).toEqual({
      userId: 'u1',
      scope: ['user:u1'],
      userIds: ['u1'],
    });
    expect(packSceneScopeStamp(undefined)).toEqual({ scope: [] });
    // The document wrapper is the same fold (no drift between origins).
    expect(sceneScopeStamp({ userId: 'u1' })).toEqual(packSceneScopeStamp('u1'));
    expect(sceneScopeStamp({})).toEqual(packSceneScopeStamp(undefined));
    const scoped = buildPackSceneRow({ ...common, idTail: 'x', userId: 'u1', origin: {} });
    expect(scoped.userId).toBe('u1');
    expect(scoped.userIds).toEqual(['u1']);
  });

  it('adds piiClass only when the origin reported classes', () => {
    const clean = buildPackSceneRow({ ...common, idTail: 'x', origin: {} });
    expect('piiClass' in clean).toBe(false);
    const dirty = buildPackSceneRow({ ...common, idTail: 'x', piiClass: ['email'], origin: {} });
    expect(dirty.piiClass).toEqual(['email']);
  });

  it('clamps confidence into the 0106 [0,1] assert on both row and delta', () => {
    expect(
      buildPackSceneRow({ ...common, idTail: 'x', confidence: 4, origin: {} }).confidence,
    ).toBe(1);
    expect(
      buildPackSceneRow({ ...common, idTail: 'x', confidence: Number.NaN, origin: {} }).confidence,
    ).toBe(0.7);
    expect(
      packStateDeltaEntry({
        packId: PACK_ID,
        stateModelId: 'm',
        subject: 's',
        to: 'x',
        confidence: -2,
      }),
    ).toEqual({
      stateModelId: 'm',
      field: `${PACK_ID}__m`,
      subject: 's',
      from: undefined,
      to: 'x',
      confidence: 0,
    });
    // candidateId is document-origin only — never invented for a turn.
    expect(
      'candidateId' in
        packStateDeltaEntry({
          packId: PACK_ID,
          stateModelId: 'm',
          subject: 's',
          to: 'x',
          confidence: 1,
        }),
    ).toBe(false);
  });

  it('stamps the SAME pack-namespaced belief field on both origins', () => {
    // The `field` the promotion pass keys on is derived in the shared
    // module, so an origin cannot drift: declared `field` wins, the
    // stateModel id is the default, and the packId always namespaces.
    const entry = (stateModelId: string, models?: Parameters<typeof packDeltaField>[2]) =>
      packStateDeltaEntry({
        packId: PACK_ID,
        stateModelId,
        models,
        subject: 's',
        to: 'x',
        confidence: 1,
      }).field;
    expect(entry('listing_lifecycle', packStateModelIndex(MODEL.stateModels))).toBe(
      `${PACK_ID}__listing_lifecycle`,
    );
    expect(
      entry(
        'listing_lifecycle',
        packStateModelIndex([{ id: 'listing_lifecycle', field: 'listing_status' }]),
      ),
    ).toBe(`${PACK_ID}__listing_status`);
    // Unresolvable declarations degrade to the id — never to no field.
    expect(entry('listing_lifecycle')).toBe(`${PACK_ID}__listing_lifecycle`);
    expect(packDeltaField(PACK_ID, 'listing_lifecycle')).toBe(entry('listing_lifecycle'));
  });

  it('derives a deterministic id per (owner, version, discriminator)', () => {
    const v = packSceneVersion(PACK_ID, PACK_VERSION);
    expect(packSceneIdTail(EPISODE_ID, v, 'viewing')).toBe(
      packSceneIdTail(EPISODE_ID, v, 'viewing'),
    );
    expect(packSceneIdTail(EPISODE_ID, v, 'viewing')).not.toBe(
      packSceneIdTail(EPISODE_ID, v, 'closing'),
    );
    expect(packSceneIdTail(EPISODE_ID, v, 'viewing')).not.toBe(
      packSceneIdTail('episode:turn2', v, 'viewing'),
    );
    expect(packSceneIdTail(EPISODE_ID, v, 'viewing')).toMatch(/^[0-9a-f]{24}$/);
    expect(packSceneProjectionName(PACK_ID)).toBe(`scenes:${PACK_ID}`);
  });
});

// ── 2. the model-free derivation ─────────────────────────────────────────

describe('derivePackScenes', () => {
  const derive = (text: string, model: PackMemoryModel = MODEL, subject?: string) =>
    derivePackScenes({ text, model, subject });

  it('fires a scene per matched schema, labelled from the pack vocabulary', () => {
    const scenes = derive('The viewing went well and escrow opens Monday.');
    expect(scenes.map((s) => s.schemaId)).toEqual(['viewing', 'closing']);
    expect(scenes[0]!.label).toBe('viewing · viewing');
    expect(scenes[1]!.label).toBe('closing · escrow');
    expect(scenes[0]!.gist).toBe('The viewing went well and escrow opens Monday.');
  });

  it('stays silent without a literal cue match and for cue-less schemas', () => {
    expect(derive('Nothing in this turn matches the pack.')).toEqual([]);
    // 'silent' declares no cues — it can never fire, so a turn naming it
    // literally still projects nothing.
    expect(derive('silent')).toEqual([]);
    expect(derive('', MODEL)).toEqual([]);
    expect(derive('viewing', { sceneSchemas: [] })).toEqual([]);
  });

  it('is case- and form-insensitive but never a pattern', () => {
    expect(derive('An OPEN HOUSE is booked.').map((s) => s.schemaId)).toEqual(['viewing']);
    expect(derive('open  house').map((s) => s.schemaId)).toEqual([]);
  });

  it('firms the confidence up with each extra cue, bounded', () => {
    expect(derive('viewing').at(0)!.confidence).toBeCloseTo(0.5);
    expect(derive('the viewing at the open house').at(0)!.confidence).toBeCloseTo(0.6);
  });

  it('reads declared states as an advisory from → to delta', () => {
    const [scene] = derive('The viewing listed the flat, now it is under offer.', MODEL, 'Elm St');
    expect(scene!.stateDeltas).toEqual([
      {
        stateModelId: 'listing_lifecycle',
        subject: 'Elm St',
        from: 'listed',
        to: 'under_offer',
        confidence: 0.6,
      },
    ]);
  });

  it('emits a bare destination when only one state is named', () => {
    const [scene] = derive('Viewing done — the place sold.', MODEL, 'Elm St');
    expect(scene!.stateDeltas).toEqual([
      {
        stateModelId: 'listing_lifecycle',
        subject: 'Elm St',
        to: 'sold',
        confidence: 0.5,
      },
    ]);
  });

  it('matches states as whole words only and ignores undeclared ones', () => {
    // 'let' is a declared state; 'letter'/'outlet' must not trip it, and
    // 'demolished' is not declared at all.
    expect(derive('Viewing: the letter about the outlet, demolished.').at(0)!.stateDeltas).toEqual(
      [],
    );
    expect(derive('Viewing: the flat is let now.').at(0)!.stateDeltas).toHaveLength(1);
  });

  it('falls back to the declared subjectType when no entity was extracted', () => {
    const [scene] = derive('Viewing — sold.');
    expect(scene!.stateDeltas[0]!.subject).toBe('listing');
  });

  it('hangs deltas off the FIRST fired scene only (the sceneIndex fence)', () => {
    const scenes = derive('Viewing, then escrow — sold.', MODEL, 'Elm St');
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.stateDeltas).toHaveLength(1);
    expect(scenes[1]!.stateDeltas).toEqual([]);
  });

  it('skips malformed declarations instead of throwing', () => {
    const junk = {
      sceneSchemas: [
        { id: 42, cues: ['viewing'] },
        { id: 'ok', description: 'd', cues: 'viewing' },
        { id: 'fine', description: 'd', cues: ['x', 'viewing'] },
      ],
      stateModels: [
        { subjectType: 'x', states: ['sold'] },
        { id: 'm2', states: 'sold' },
      ],
    } as unknown as PackMemoryModel;
    const scenes = derivePackScenes({ text: 'The viewing sold it.', model: junk });
    expect(scenes.map((s) => s.schemaId)).toEqual(['fine']);
    expect(scenes[0]!.stateDeltas).toEqual([]);
  });

  it('trims an oversized turn into a bounded gist', () => {
    const long = `viewing ${'x'.repeat(2_000)}`;
    expect(derive(long).at(0)!.gist.length).toBeLessThanOrEqual(500);
  });
});

// ── 3. the producer service ──────────────────────────────────────────────

interface Recorded {
  sql: string;
  vars: Record<string, unknown> | undefined;
}

function makeService(bindings: PackMemoryModelBinding[], opts: { fail?: boolean } = {}) {
  const queries: Recorded[] = [];
  const db = {
    query: async (sql: string, vars?: Record<string, unknown>) => {
      queries.push({ sql, vars });
      if (opts.fail) throw new Error('surreal down');
      return [];
    },
  };
  let withCompanyCalls = 0;
  const surreal = {
    withCompany: async (_co: string, fn: (d: unknown) => Promise<unknown>) => {
      withCompanyCalls += 1;
      return fn(db);
    },
  } as unknown as SurrealService;
  const reader = {
    installedMemoryModels: jest.fn(async () => bindings),
  } as unknown as MemoryModelReaderService;
  const registry = {
    begin: jest.fn(async () => undefined),
    complete: jest.fn(async () => undefined),
    fail: jest.fn(async () => undefined),
  } as unknown as ProjectionRegistryService;
  const svc = new MentionProjectionService(surreal, reader, registry);
  return { svc, queries, reader, registry, calls: () => withCompanyCalls };
}

const dto = (over: Partial<IngestMentionDto> = {}): IngestMentionDto =>
  ({
    text: 'The viewing went well — it is under offer now.',
    contextRef: { vertical: 'crm', conversationId: 'conv1', messageId: 'm1' },
    emittedAt: '2026-09-01T10:00:00.000Z',
    userId: 'u1',
    ...over,
  }) as IngestMentionDto;

describe('MentionProjectionService', () => {
  const saved = process.env.PACK_MEMORY_PROJECTIONS_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.PACK_MEMORY_PROJECTIONS_ENABLED;
    else process.env.PACK_MEMORY_PROJECTIONS_ENABLED = saved;
  });

  it('is a byte-identical no-op with the flag off — not even a cache read', async () => {
    delete process.env.PACK_MEMORY_PROJECTIONS_ENABLED;
    const { svc, queries, reader, registry, calls } = makeService([BINDING]);
    await expect(
      svc.projectTurn({ companyId: 'co', dto: dto(), episodeId: EPISODE_ID }),
    ).resolves.toEqual([]);
    expect(reader.installedMemoryModels).not.toHaveBeenCalled();
    expect(registry.begin).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
    expect(calls()).toBe(0);
  });

  it('exits before any write for a tenant with no memory-model packs', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, queries, registry, calls } = makeService([]);
    await expect(
      svc.projectTurn({ companyId: 'co', dto: dto(), episodeId: EPISODE_ID }),
    ).resolves.toEqual([]);
    expect(registry.begin).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
    expect(calls()).toBe(0);
  });

  it('writes nothing when the turn matches no cue of an installed pack', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, queries, registry } = makeService([BINDING]);
    const out = await svc.projectTurn({
      companyId: 'co',
      dto: dto({ text: 'Unrelated chatter about lunch.' }),
      episodeId: EPISODE_ID,
    });
    expect(out).toEqual([]);
    expect(registry.begin).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });

  it('declines to project a turn with no captured episode (no erasure anchor)', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, queries } = makeService([BINDING]);
    await expect(svc.projectTurn({ companyId: 'co', dto: dto(), episodeId: '' })).resolves.toEqual(
      [],
    );
    expect(queries).toHaveLength(0);
  });

  it('projects one transaction with the shared row shape + an L0 member edge', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, queries, registry } = makeService([BINDING]);
    const out = await svc.projectTurn({
      companyId: 'co',
      dto: dto(),
      episodeId: EPISODE_ID,
      subject: '12 Elm St',
    });
    const version = packSceneVersion(PACK_ID, PACK_VERSION);
    expect(out).toEqual([{ packId: PACK_ID, version, scenes: 1, stateDeltas: 1 }]);
    expect(registry.begin).toHaveBeenCalledWith({
      companyId: 'co',
      name: `scenes:${PACK_ID}`,
      version,
      builder: PACK_SCENE_PROJECTOR,
    });
    expect(registry.complete).toHaveBeenCalledWith(
      expect.objectContaining({ name: `scenes:${PACK_ID}`, version, live: false }),
    );

    // ONE round-trip for the whole swap.
    expect(queries).toHaveLength(1);
    const { sql, vars } = queries[0]!;
    expect(sql).toContain('BEGIN TRANSACTION');
    // Primary-key addressed: the ids are bound, never re-selected, and no
    // DELETE/UPDATE filters an indexed field (the 3.2.4 planner rule).
    expect(sql).toContain('LET $oldIds = $sliceIds');
    expect(sql).toContain('DELETE memory_episode WHERE id INSIDE $oldIds');
    expect(sql).toContain('LET $oldMemberIds = (SELECT VALUE id FROM memory_episode_member');
    expect(sql).toContain('INSERT RELATION INTO memory_episode_member $memberRows');

    const rows = vars!.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sceneLabel).toBe('viewing · viewing');
    expect(row.gist).toBe('The viewing went well — it is under offer now.');
    expect(row.segmenterVersion).toBe(version);
    expect(row.conversationIds).toEqual(['conv1']);
    expect(row.userId).toBe('u1');
    expect(row.scope).toEqual(['user:u1']);
    expect(row.userIds).toEqual(['u1']);
    expect(row.source).toEqual({
      recorder: PACK_SCENE_PROJECTOR,
      episodeId: new StringRecordId(EPISODE_ID),
      packId: PACK_ID,
      packVersion: PACK_VERSION,
      schemaId: 'viewing',
    });
    expect(row.stateDeltas).toEqual([
      {
        stateModelId: 'listing_lifecycle',
        // The belief key, resolved from the binding's own memoryModel —
        // the same entry the document origin projects.
        field: `${PACK_ID}__listing_lifecycle`,
        subject: '12 Elm St',
        from: undefined,
        to: 'under_offer',
        confidence: 0.5,
      },
    ]);

    // The membership edge GDPR erasure rides: scene → the L0 turn.
    const members = vars!.memberRows as Array<Record<string, unknown>>;
    expect(members).toHaveLength(1);
    expect(members[0]!.out).toEqual(new StringRecordId(EPISODE_ID));
    expect(members[0]!.in).toEqual(rows[0]!.id);
    expect(members[0]).toMatchObject({
      role: 'core',
      ord: 0,
      relevance: 1,
      segmenterVersion: version,
    });
  });

  it('is idempotent per (turn, pack, schema) — a replay rewrites the same ids', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, queries } = makeService([BINDING]);
    const call = () => svc.projectTurn({ companyId: 'co', dto: dto(), episodeId: EPISODE_ID });
    await call();
    await call();
    expect(queries).toHaveLength(2);
    const idsOf = (i: number) =>
      (queries[i]!.vars!.rows as Array<{ id: RecordId }>).map((r) => String(r.id));
    expect(idsOf(0)).toEqual(idsOf(1));
    // The swapped slice covers EVERY declared schema, so a schema that
    // stops firing leaves no orphan behind.
    const version = packSceneVersion(PACK_ID, PACK_VERSION);
    const slice = (queries[0]!.vars!.sliceIds as RecordId[]).map(String);
    expect(slice).toEqual(
      ['viewing', 'closing', 'silent'].map(
        (s) => `memory_episode:${packSceneIdTail(EPISODE_ID, version, s)}`,
      ),
    );
    expect(slice).toContain(idsOf(0)[0]);
  });

  it('soft-fails one pack without throwing, and marks its ledger row failed', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, registry } = makeService([BINDING], { fail: true });
    await expect(
      svc.projectTurn({ companyId: 'co', dto: dto(), episodeId: EPISODE_ID }),
    ).resolves.toEqual([]);
    expect(registry.fail).toHaveBeenCalledWith(
      expect.objectContaining({ name: `scenes:${PACK_ID}` }),
    );
    expect(registry.complete).not.toHaveBeenCalled();
  });

  it('projects a tenant-global turn with the empty scope fold', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, queries } = makeService([BINDING]);
    await svc.projectTurn({
      companyId: 'co',
      dto: dto({ userId: undefined, contextRef: { vertical: 'crm', messageId: 'm2' } }),
      episodeId: EPISODE_ID,
    });
    const row = (queries[0]!.vars!.rows as Array<Record<string, unknown>>)[0]!;
    expect(row.userId).toBeUndefined();
    expect(row.scope).toEqual([]);
    expect(row.conversationIds).toEqual([]);
  });

  it('projects the REDACTED turn text, stamped with its PII classes', async () => {
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const { svc, queries } = makeService([BINDING]);
    await svc.projectTurn({
      companyId: 'co',
      dto: dto({ text: 'Viewing booked — mail me at buyer@example.com.' }),
      episodeId: EPISODE_ID,
    });
    const row = (queries[0]!.vars!.rows as Array<Record<string, unknown>>)[0]!;
    expect(row.gist).toBe('Viewing booked — mail me at [EMAIL].');
    expect(row.piiClass).toEqual(['email']);
  });
});
