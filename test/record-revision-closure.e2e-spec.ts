/**
 * #830: what a record stops saying stops being open (real SurrealDB).
 *  - a revision without a field closes that field's fact at the revision's
 *    time; the values it restates stay open;
 *  - a revision without a relation closes the edge;
 *  - a gone record closes its edges, not only its facts;
 *  - an edge two documents assert stays open until the last one leaves,
 *    an edge a conversation also said is never closed by a document, and
 *    a returning item reopens exactly the closes it caused (0178).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { createEdgeBetween } from '../src/ingest/edge-writer';
import {
  markUndocumented,
  restoreEdgeSupport,
  retireEdgeSupport,
} from '../src/ingest/edge-support';

const COMPANY = 'co_record_revision_e2e';
const ENV = ['SOURCE_PLANE_ENABLED', 'DOCUMENT_INGEST_ENABLED', 'WORKER_LOOP_ENABLED'];

describe('record revisions and gone records close what they no longer say (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};
  let pushId = '';

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      DOCUMENT_INGEST_ENABLED: '1',
    });
    f = await createApp({ companyId: COMPANY });
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: CRM_MEMORY_PACK, acceptSources: true });
    expect([200, 201]).toContain(install.status);
    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'push',
        vertical: 'crm',
        label: 'push',
        config: {
          mapping: {
            deal: {
              fields: { value: 'deal_amount', currency: 'currency', stage: 'deal_stage' },
            },
          },
        },
      });
    expect(conn.status).toBe(201);
    pushId = conn.body.id;
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (f) await f.close();
  });

  const withDb = <T>(fn: Parameters<SurrealService['withCompany']>[1]) =>
    f.app.get(SurrealService).withCompany(COMPANY, fn) as Promise<T>;
  const rows = <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> =>
    withDb(async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  const push = (body: Record<string, unknown>) =>
    f.http.post(`/v1/source-connections/${pushId}/records`).set(auth()).send(body);
  const deal = (
    id: string,
    attributes: Record<string, unknown>,
    updatedAt: string,
    org = true,
  ) => ({
    entityType: 'deal',
    externalId: id,
    name: `Deal ${id}`,
    attributes,
    relations: org
      ? [
          {
            kind: 'organization',
            targetType: 'organization',
            targetExternalId: '7',
            targetName: 'Acme Robotics',
          },
        ]
      : [],
    updatedAt,
  });
  const open = (predicate: string) =>
    rows<{ object: string; validUntil?: unknown }>(
      `SELECT object, validUntil FROM knowledge_fact WHERE predicate = $p AND status IN ['active', 'corroborating', 'competing']`,
      { p: predicate },
    );
  const orgEdges = () =>
    rows<{ validUntil?: unknown; source: Record<string, unknown> }>(
      `SELECT validUntil, source FROM knowledge_edge WHERE kind = 'organization'`,
    );

  it('a revision without a field or a relation closes them at its time; restated values stay open', async () => {
    const first = await push({
      records: [
        deal('1', { value: 100, currency: 'EUR', stage: 'Proposal' }, '2026-09-10T10:00:00.000Z'),
      ],
    });
    expect(first.body).toMatchObject({ ingested: 1 });
    expect((await orgEdges()).every((e) => e.validUntil == null)).toBe(true);

    const second = await push({
      records: [deal('1', { value: 100, stage: 'Proposal' }, '2026-09-20T10:00:00.000Z', false)],
    });
    expect(second.body).toMatchObject({ ingested: 1 });

    const currency = await open('crm_memory__currency');
    expect(currency).toHaveLength(1);
    expect(new Date(currency[0]!.validUntil as string).toISOString()).toBe(
      '2026-09-20T10:00:00.000Z',
    );
    // Restated: the first row stays open, the second corroborates it.
    expect((await open('crm_memory__deal_amount')).filter((r) => r.validUntil == null).length).toBe(
      2,
    );
    expect((await open('crm_memory__deal_stage')).every((r) => r.validUntil == null)).toBe(true);
    const edges = await orgEdges();
    expect(edges).toHaveLength(1);
    expect(new Date(edges[0]!.validUntil as string).toISOString()).toBe('2026-09-20T10:00:00.000Z');
  });

  it('a gone record closes its edges as well as its facts', async () => {
    await push({ records: [deal('2', { stage: 'Won' }, '2026-09-12T10:00:00.000Z')] });
    const live = (await orgEdges()).filter((e) => e.validUntil == null);
    expect(live).toHaveLength(1);
    const gone = await push({ records: [], gone: ['deal/2'] });
    expect(gone.body).toMatchObject({ gone: 1 });
    expect((await orgEdges()).every((e) => e.validUntil != null)).toBe(true);
  });

  it('an edge stays open while any document or a conversation asserts it; a return reopens', async () => {
    const [a, b] = await rows<{ id: unknown }>(
      `CREATE knowledge_entity CONTENT { canonicalName: 'Support A', type: 'staff' };
       CREATE knowledge_entity CONTENT { canonicalName: 'Support B', type: 'customer' };`,
    ).then(async () =>
      rows<{ id: unknown }>(
        `SELECT id, canonicalName FROM knowledge_entity WHERE canonicalName IN ['Support A', 'Support B'] ORDER BY canonicalName`,
      ),
    );
    const edge = (documentId: string) =>
      withDb<string | null>((db) =>
        createEdgeBetween(db, {
          fromEntityId: String(a!.id),
          toEntityId: String(b!.id),
          kind: 'works_at',
          source: { vertical: 'crm', documentId },
        }),
      );
    const id = (await edge('source_document:d1'))!;
    expect(await edge('source_document:d2')).toBe(id);
    const at = new Date('2026-09-30T00:00:00.000Z');
    const state = async () =>
      (await rows<{ validUntil?: unknown }>(`SELECT validUntil FROM type::record($id)`, { id }))[0]!
        .validUntil;

    await withDb((db) => retireEdgeSupport(db, { documentIds: ['source_document:d1'], at }));
    expect(await state()).toBeUndefined();
    await withDb((db) => retireEdgeSupport(db, { documentIds: ['source_document:d2'], at }));
    expect(new Date((await state()) as string).getTime()).toBe(at.getTime());

    await withDb((db) => restoreEdgeSupport(db, { documentIds: ['source_document:d2'], at }));
    expect(await state()).toBeUndefined();

    await withDb((db) => markUndocumented(db, [id]));
    await withDb((db) =>
      retireEdgeSupport(db, { documentIds: ['source_document:d1', 'source_document:d2'], at }),
    );
    expect(await state()).toBeUndefined();
  });
});
