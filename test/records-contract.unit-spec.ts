/**
 * The records contract (W4.2):
 *  - mapRecord: mapped attributes → facts qualified to the pack (core
 *    predicates allowed, unknown ones dropped by name), relation targets →
 *    entities with scoped external ids, a lifecycle value → a declared
 *    state, prose keys → text fields; the render carries every value;
 *  - the RecordsConnector runtime over a memory source: per-entity
 *    checkpoints, the overlap window, one item per record with the
 *    updatedAt as revision, fetch from the run cache, unnamed relation
 *    targets named by `get` (bounded), a full run ignores the checkpoint;
 *  - the Pipedrive connector against the fake: rows → envelopes with
 *    stage / pipeline / owner names, primary e-mail, relations by id;
 *    an API token rides x-api-token, a connected account a bearer.
 */
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import type { ConnectorCtx, ItemDelta, RecordEnvelope } from '../src/source-plane/connector';
import { PipedriveConnector } from '../src/source-plane/connectors/pipedrive.connector';
import { mapRecord, mergeMappings } from '../src/source-plane/records/record-mapping';
import {
  RecordsConnector,
  type EntitySpec,
  type ListCursor,
  type ListPage,
} from '../src/source-plane/records/records-connector';
import { submissionOf, vocabularyOf } from '../src/source-plane/records/records-door.service';
import { startFakeCloud, type FakeCloud } from './fixtures/fake-cloud';

const vocab = vocabularyOf(CRM_MEMORY_PACK);
const scope = (t: string, id: string) => `src_c1:${t}:${id}`;

describe('mapRecord', () => {
  const deal: RecordEnvelope = {
    entityType: 'deal',
    externalId: '4812',
    name: 'Acme — ledger migration',
    attributes: {
      value: 40000,
      currency: 'EUR',
      stage: 'Negotiation',
      status: 'open',
      notes: 'Call Friday.',
      empty: '',
    },
    relations: [
      {
        kind: 'organization',
        targetType: 'organization',
        targetExternalId: '7',
        targetName: 'Acme Robotics',
      },
      { kind: 'primary_contact', targetType: 'person', targetExternalId: '12' },
    ],
    updatedAt: '2026-09-15T10:00:00.000Z',
  };

  it('turns mapped attributes into qualified facts, targets into entities, prose into text fields; drops by name', () => {
    const m = mapRecord({
      record: deal,
      mapping: {
        fields: {
          value: 'deal_amount',
          currency: 'currency',
          stage: 'deal_stage',
          status: 'nonsense',
          empty: 'pipeline',
          email: 'email',
        },
        text: ['notes'],
        lifecycle: { field: 'status', model: 'deal_stage', states: { open: 'negotiation' } },
      },
      vocab,
      idScope: scope,
    });
    expect(m.facts).toEqual([
      { entityIndex: 0, predicate: 'crm_memory__deal_amount', object: '40000' },
      { entityIndex: 0, predicate: 'crm_memory__currency', object: 'EUR' },
      { entityIndex: 0, predicate: 'crm_memory__deal_stage', object: 'Negotiation' },
    ]);
    expect(m.dropped).toEqual([
      { key: 'status', reason: 'unknown_predicate' },
      { key: 'primary_contact', reason: 'unnamed_target' },
    ]);
    expect(m.entities).toEqual([
      { name: 'Acme — ledger migration', type: 'project', externalId: 'src_c1:deal:4812' },
      { name: 'Acme Robotics', type: 'customer', externalId: 'src_c1:organization:7' },
    ]);
    expect(m.relations).toEqual([{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'organization' }]);
    expect(m.stateDelta).toEqual({ model: 'deal_stage', to: 'negotiation' });
    expect(m.textFields).toEqual([{ key: 'notes', value: 'Call Friday.' }]);
    for (const f of m.facts) expect(m.text).toContain(f.object);
    expect(m.text).toContain('organization: organization Acme Robotics');
    // A core predicate is allowed unprefixed; a scope-gated one is not in the vocabulary.
    expect(vocab.corePredicates.has('email')).toBe(true);
    expect(vocab.corePredicates.has('dob')).toBe(false);
    const dto = submissionOf('crm_memory', m, deal);
    expect(dto.indexerId).toBe('crm_memory');
    expect(dto.entities[0]).toEqual({
      name: 'Acme — ledger migration',
      type: 'project',
      externalId: 'src_c1:deal:4812',
    });
    expect(dto.facts.every((f) => f.confidence === 1)).toBe(true);
  });

  it('merges a connection mapping over the preset per entity', () => {
    const merged = mergeMappings(
      { deal: { fields: { value: 'deal_amount', stage: 'deal_stage' }, coreType: 'project' } },
      {
        deal: { fields: { stage: 'pipeline', custom_x: 'label' }, text: ['notes'] },
        person: { fields: { email: 'email' } },
      },
    );
    expect(merged.deal).toEqual({
      fields: { value: 'deal_amount', stage: 'pipeline', custom_x: 'label' },
      text: ['notes'],
      coreType: 'project',
    });
    expect(merged.person).toEqual({ fields: { email: 'email' } });
  });
});

/** A vendor in memory: two entity types, updated-at filtering, 2-per-page cursors. */
class MemorySource extends RecordsConnector {
  readonly kind = 'memory';
  readonly entities: EntitySpec[] = [
    { type: 'organization', label: 'Orgs', defaultOn: true, fields: [] },
    { type: 'deal', label: 'Deals', defaultOn: true, fields: [{ key: 'stage', label: 'Stage' }] },
    { type: 'note', label: 'Notes', defaultOn: false, fields: [] },
  ];
  readonly preset = { deal: { fields: { stage: 'deal_stage' } } };
  rows: Record<string, RecordEnvelope[]> = { organization: [], deal: [], note: [] };
  calls: Array<{ entity: string; cursor: ListCursor }> = [];
  gets: string[] = [];
  async list(_ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage> {
    this.calls.push({ entity, cursor });
    const all = (this.rows[entity] ?? []).filter(
      (r) => !cursor.since || (r.updatedAt ?? '') >= cursor.since,
    );
    const start = typeof cursor.page === 'number' ? cursor.page : 0;
    const page = all.slice(start, start + 2);
    return { records: page, next: start + 2 < all.length ? start + 2 : null };
  }
  override async get(
    _ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    this.gets.push(`${entity}/${id}`);
    return (this.rows[entity] ?? []).find((r) => r.externalId === id) ?? null;
  }
}

function ctxOf(
  config: Record<string, unknown> = {},
  credentialSource: 'grant' | 'secret' | null = 'grant',
): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: 'source_connection:c1',
      packId: 'crm_memory',
      sourceId: 'x',
      kind: 'native',
      connector: 'memory',
      shape: 'structure',
      host: 'server',
      config,
      credential: 'tok',
      credentialSource,
      contentPolicy: 'text',
      vertical: 'crm',
      recorder: 'r',
      userId: null,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

async function collect(it: AsyncIterable<ItemDelta>) {
  const upserts: Array<{ externalId: string; revision?: string | undefined }> = [];
  let checkpoint: Record<string, unknown> | null = null;
  for await (const d of it) {
    if (d.type === 'upsert')
      upserts.push({ externalId: d.item.externalId, revision: d.item.revision });
    else if (d.type === 'checkpoint') checkpoint = d.checkpoint;
  }
  return { upserts, checkpoint };
}

describe('RecordsConnector runtime', () => {
  const org = (id: string, name: string, at: string): RecordEnvelope => ({
    entityType: 'organization',
    externalId: id,
    name,
    attributes: {},
    updatedAt: at,
  });
  const deal = (id: string, name: string, at: string, orgId: string): RecordEnvelope => ({
    entityType: 'deal',
    externalId: id,
    name,
    attributes: { stage: 'Proposal' },
    relations: [{ kind: 'organization', targetType: 'organization', targetExternalId: orgId }],
    updatedAt: at,
  });

  it('lists the default entities page by page, one item per record, and checkpoints per entity', async () => {
    const src = new MemorySource();
    src.rows.organization = [
      org('7', 'Acme', '2026-09-01T00:00:00.000Z'),
      org('8', 'Globex', '2026-09-02T00:00:00.000Z'),
      org('9', 'Initech', '2026-09-03T00:00:00.000Z'),
    ];
    src.rows.deal = [deal('1', 'D1', '2026-09-04T00:00:00.000Z', '7')];
    src.rows.note = [{ entityType: 'note', externalId: 'n', name: 'n', attributes: {} }];
    const r = await collect(src.enumerate(ctxOf(), { checkpoint: null, full: true }));
    expect(r.upserts.map((u) => u.externalId)).toEqual([
      'organization/7',
      'organization/8',
      'organization/9',
      'deal/1',
    ]);
    expect(r.upserts[0]!.revision).toBe('at:2026-09-01T00:00:00.000Z');
    expect(src.calls.filter((c) => c.entity === 'organization').length).toBe(2);
    expect(src.calls.some((c) => c.entity === 'note')).toBe(false);
    const cp = r.checkpoint as { entities: Record<string, { since: string }> };
    expect(Object.keys(cp.entities).sort()).toEqual(['deal', 'organization']);
    // fetch: from the run cache, relation target named from the same run — no get.
    const fetched = await src.fetch(ctxOf(), { externalId: 'deal/1' });
    expect(fetched).toMatchObject({
      shape: 'structure',
      mapping: { fields: { stage: 'deal_stage' } },
    });
    expect((fetched as { record: RecordEnvelope }).record.relations?.[0]?.targetName).toBe('Acme');
    expect(src.gets).toEqual([]);
    // an incremental run widens `since` by the overlap and passes it to the vendor
    src.calls = [];
    await collect(src.enumerate(ctxOf({ overlapMinutes: 15 }), { checkpoint: cp, full: false }));
    const since = src.calls.find((c) => c.entity === 'deal')!.cursor.since!;
    expect(new Date(cp.entities.deal!.since).getTime() - new Date(since).getTime()).toBe(
      15 * 60_000,
    );
    await src.endRun(ctxOf());
  });

  it('names an unlisted relation target through get, honours the entity selection and the own mapping', async () => {
    const src = new MemorySource();
    src.rows.organization = [org('7', 'Acme', '2026-09-01T00:00:00.000Z')];
    src.rows.deal = [deal('1', 'D1', '2026-09-04T00:00:00.000Z', '7')];
    const ctx = ctxOf({ entities: ['deal'], mapping: { deal: { fields: { stage: 'pipeline' } } } });
    const r = await collect(src.enumerate(ctx, { checkpoint: null, full: true }));
    expect(r.upserts.map((u) => u.externalId)).toEqual(['deal/1']);
    const fetched = (await src.fetch(ctx, { externalId: 'deal/1' })) as {
      record: RecordEnvelope;
      mapping: { fields: Record<string, string> };
    };
    expect(fetched.record.relations?.[0]?.targetName).toBe('Acme');
    expect(src.gets).toEqual(['organization/7']);
    expect(fetched.mapping.fields).toEqual({ stage: 'pipeline' });
    // a record never listed this run is fetched through get; a gone one is an error by name
    src.rows.deal.push(deal('2', 'D2', '2026-09-05T00:00:00.000Z', '7'));
    expect(
      ((await src.fetch(ctx, { externalId: 'deal/2' })) as { record: RecordEnvelope }).record.name,
    ).toBe('D2');
    await expect(src.fetch(ctx, { externalId: 'deal/404' })).rejects.toThrow(/gone at the source/);
  });
});

describe('pipedrive', () => {
  let cloud: FakeCloud;
  let token = '';
  const saved: Record<string, string | undefined> = {};
  const c = new PipedriveConnector();
  beforeAll(async () => {
    cloud = await startFakeCloud();
    token = cloud.mint();
    cloud.pipedrive.apiTokens.add('api-token-1');
    for (const k of ['SOURCE_EGRESS_ALLOW_PRIVATE', 'SOURCE_OAUTH_PIPEDRIVE_BASE_URL'])
      saved[k] = process.env[k];
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    process.env.SOURCE_OAUTH_PIPEDRIVE_BASE_URL = cloud.base;
    cloud.pipedrive.stages = [{ id: 3, name: 'Negotiation', pipeline_id: 1 }];
    cloud.pipedrive.pipelines = [{ id: 1, name: 'Sales' }];
    cloud.pipedrive.users = [{ id: 9, name: 'Grace Hopper' }];
    cloud.pipedrive.organizations = [
      {
        id: 7,
        name: 'Acme Robotics',
        owner_id: 9,
        address: { value: 'Tallinn' },
        update_time: '2026-09-01 10:00:00',
      },
    ];
    cloud.pipedrive.persons = [
      {
        id: 12,
        name: 'Ada Lovelace',
        job_title: 'CTO',
        owner_id: 9,
        org_id: 7,
        emails: [
          { value: 'old@x', primary: false },
          { value: 'ada@acme.test', primary: true },
        ],
        phones: [],
        update_time: '2026-09-02 10:00:00',
      },
    ];
    cloud.pipedrive.deals = [
      {
        id: 4812,
        title: 'Ledger migration',
        value: 40000,
        currency: 'EUR',
        status: 'open',
        stage_id: 3,
        owner_id: 9,
        person_id: 12,
        org_id: 7,
        expected_close_date: '2026-10-31',
        probability: 60,
        update_time: '2026-09-15 10:00:00',
      },
      { id: 4813, title: 'Old', is_deleted: true, update_time: '2026-09-16 10:00:00' },
    ];
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await cloud.close();
  });
  const ctx = (cred: string, src: 'grant' | 'secret'): ConnectorCtx => ({
    ...ctxOf({}, src),
    connection: { ...ctxOf({}, src).connection, connector: 'pipedrive', credential: cred },
  });

  it('lists deals / persons / organizations as envelopes with names resolved, relations by id, deleted rows skipped', async () => {
    const deals = await c.list(ctx(token, 'grant'), 'deal', { since: null, page: null });
    expect(deals.records).toHaveLength(1);
    expect(deals.records[0]).toMatchObject({
      entityType: 'deal',
      externalId: '4812',
      name: 'Ledger migration',
      attributes: {
        value: 40000,
        currency: 'EUR',
        status: 'open',
        stage: 'Negotiation',
        pipeline: 'Sales',
        owner: 'Grace Hopper',
        expected_close_date: '2026-10-31',
        probability: 60,
      },
      relations: [
        { kind: 'primary_contact', targetType: 'person', targetExternalId: '12' },
        { kind: 'organization', targetType: 'organization', targetExternalId: '7' },
      ],
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
    const persons = await c.list(ctx(token, 'grant'), 'person', { since: null, page: null });
    expect(persons.records[0]).toMatchObject({
      name: 'Ada Lovelace',
      attributes: { email: 'ada@acme.test', job_title: 'CTO', owner: 'Grace Hopper' },
    });
    const orgs = await c.list(ctx(token, 'grant'), 'organization', {
      since: '2026-09-02T00:00:00.000Z',
      page: null,
    });
    expect(orgs.records).toHaveLength(0);
    const bearer = cloud.calls.filter((x) => x.path.startsWith('/api/v2/deals')).pop();
    expect(bearer?.auth).toBe(`Bearer ${token}`);
    await c.endRun(ctx(token, 'grant'));
  });

  it('an API token rides x-api-token, not a bearer; the whole runtime walks the account', async () => {
    const r = await collect(
      c.enumerate(ctx('api-token-1', 'secret'), { checkpoint: null, full: true }),
    );
    expect(r.upserts.map((u) => u.externalId)).toEqual([
      'deal/4812',
      'person/12',
      'organization/7',
    ]);
    const call = cloud.calls.filter((x) => x.path.startsWith('/api/v2/persons')).pop();
    expect(call?.auth).toBeNull();
    const fetched = (await c.fetch(ctx('api-token-1', 'secret'), { externalId: 'deal/4812' })) as {
      record: RecordEnvelope;
      mapping: { fields: Record<string, string> };
    };
    expect(fetched.record.relations?.map((x) => x.targetName)).toEqual([
      'Ada Lovelace',
      'Acme Robotics',
    ]);
    expect(fetched.mapping.fields.stage).toBe('deal_stage');
    expect(c.preset.person!.fields).toEqual({ job_title: 'job_title', owner: 'owner' });
    await c.endRun(ctx('api-token-1', 'secret'));
  });
});
