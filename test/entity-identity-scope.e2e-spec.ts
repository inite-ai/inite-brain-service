/**
 * Identity is tenant-wide, scope is on the fact — end to end on a real
 * SurrealDB (2026-09-20):
 *  - a user-scoped typed fact on `{vertical, id}` lands on the node the
 *    mention path already made for that name (adopt by name), so a later
 *    disagreement PAIRS on one node instead of splitting across a private
 *    copy and the shared one;
 *  - the legacy per-user copies written before this rule are folded back:
 *    a copy with a tenant twin is merged (facts, edges, refs travel; the
 *    timeline is whole again; the competing pair is visible), a copy with
 *    no twin becomes the tenant node itself; the user's own node stays
 *    private; a second run finds nothing to do;
 *  - user-forget after the fold erases the user's facts and no shared node.
 */
import { StringRecordId } from 'surrealdb';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { FactsService } from '../src/facts/facts.service';
import { ScopedEntityConsolidationService } from '../src/entities/scoped-entity-consolidation.service';

describe('entity identity across user scopes', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const A = 'ident_user_a';
  const B = 'ident_user_b';

  beforeAll(async () => {
    f = await createApp({ companyId: `co_identscope_${Date.now()}` });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const fact = async (body: Record<string, unknown>) => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({ confidence: 0.9, source: { vertical: 'crm', recorder: 'bot' }, ...body });
    expect([200, 201]).toContain(r.status);
    return r.body as { factId: string; outcome: string };
  };

  const entityOfFact = async (factId: string): Promise<string> =>
    surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      return String((rows as Array<{ entityId: unknown }>)[0]!.entityId);
    });

  const mention = async (text: string, userId: string | undefined, messageId: string) => {
    const r = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        ...(userId ? { userId } : {}),
        contextRef: { vertical: 'chat', conversationId: 'c-ident', messageId },
      });
    expect(r.status).toBe(201);
    return r.body as { extractedEntityIds: string[]; extractedFactIds: string[] };
  };

  const timelineObjects = async (entityId: string, userId?: string) => {
    const r = await f.http
      .get(`/v1/entities/${encodeURIComponent(entityId)}/timeline`)
      .query(userId ? { userId } : {})
      .set(auth());
    expect(r.status).toBe(200);
    return (r.body.events as Array<{ type: string; object?: string; predicate?: string }>)
      .filter((e) => e.type === 'fact.recorded')
      .map((e) => `${e.predicate}=${e.object}`);
  };

  it('a scoped typed fact on {vertical,id} lands on the node the mention path named — the disagreement pairs', async () => {
    // The mention path coins "Orbital Payments" tenant-wide.
    f.extractor.setScript({
      entities: [{ name: 'Orbital Payments', type: 'customer' }],
      facts: [{ entityIndex: 0, predicate: 'payout_cutoff', object: '17:00 UTC', confidence: 0.9 }],
      edges: [],
    });
    const m = await mention('Priya says the Orbital Payments cutoff is 17:00 UTC.', A, 'm1');
    const shared = m.extractedEntityIds[0]!;

    // The same user's typed fact by reference id — adopted onto that node
    // by name, not minted as a private copy.
    const typed = await fact({
      entityRef: { vertical: 'crm', id: 'orbital payments' },
      predicate: 'payout_cutoff',
      object: '16:30 UTC',
      validFrom: '2026-03-25',
      userId: A,
    });
    expect(await entityOfFact(typed.factId)).toBe(shared);
    // The two claims met in the resolver on ONE node (with the stub
    // embedder the verdict is INSERTED/COMPETING/SUPERSEDED by predicate
    // semantics; what matters here is that they met at all — the old
    // path never let them).
    expect(['INSERTED', 'INSERTED_HISTORICAL', 'COMPETING', 'SUPERSEDED']).toContain(typed.outcome);
    const facts = f.app.get(FactsService);
    const competing = await facts.listCompeting(f.companyId, shared, {
      predicate: 'payout_cutoff',
      userId: A,
      callerScopes: ['brain:read', 'brain:read_pii'],
    });
    for (const g of (competing.groups ?? []) as Array<{ facts: Array<{ object: string }> }>) {
      expect(g.facts.map((x) => x.object).sort()).toEqual(['16:30 UTC', '17:00 UTC']);
    }
    // Another user sees the node but neither of A's facts.
    expect(await timelineObjects(shared, B)).toEqual([]);
    expect((await timelineObjects(shared, A)).sort()).toEqual([
      'payout_cutoff=16:30 UTC',
      'payout_cutoff=17:00 UTC',
    ]);
  });

  let ledgerShared = '';
  let ledgerCopy = '';
  let orphanCopy = '';

  it('folds the legacy per-user copies: merge into the twin, re-key the orphan, leave the user’s own node', async () => {
    // The tenant node, as the mention path made it.
    f.extractor.setScript({
      entities: [
        { name: 'ledger-sync', type: 'project' },
        { name: 'Acme Cloud', type: 'customer' },
      ],
      facts: [
        { entityIndex: 0, predicate: 'pilot_launch_date', object: '2026-05-06', confidence: 0.9 },
      ],
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'deploys_to', confidence: 0.9 }],
    });
    const m = await mention('ledger-sync launches 2026-05-06 and deploys to Acme Cloud.', A, 'm2');
    ledgerShared = m.extractedEntityIds[0]!;
    const acme = m.extractedEntityIds[1]!;

    // The 0055-era rows, exactly as the old write path left them: a private
    // copy under `crm__ledger-sync::u::<A>` holding the earlier history and
    // an edge, plus an orphan copy with no tenant twin, plus the user's own
    // node (which must stay private).
    await surreal.withCompany(f.companyId, async (db) => {
      const [c] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE ONLY knowledge_entity CONTENT {
           type: 'other', canonicalName: 'ledger-sync', aliases: ['ledger-sync'],
           externalRefs: { 'crm__ledger-sync::u::ident_user_a': 'ledger-sync' },
           userId: $u, scope: ['user:ident_user_a']
         } RETURN id`,
        { u: A },
      );
      ledgerCopy = String((c as unknown as { id: unknown }).id);
      const [o] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE ONLY knowledge_entity CONTENT {
           type: 'other', canonicalName: 'zeta-batch', externalRefs: { 'crm__zeta-batch::u::ident_user_a': 'zeta-batch' },
           userId: $u, scope: ['user:ident_user_a']
         } RETURN id`,
        { u: A },
      );
      orphanCopy = String((o as unknown as { id: unknown }).id);
      await db.query(
        `CREATE entity_external_ref CONTENT { key: 'crm__ledger-sync::u::ident_user_a', entity: $copy };
         CREATE entity_external_ref CONTENT { key: 'crm__zeta-batch::u::ident_user_a', entity: $orphan };
         CREATE knowledge_fact CONTENT { entityId: $copy, predicate: 'pilot_launch_date', object: '2026-04-15',
           confidence: 0.9, validFrom: d'2026-03-02T00:00:00Z', validUntil: d'2026-03-18T00:00:00Z',
           status: 'superseded', retractionReason: 'superseded', retractedBy: 'system', userId: $u,
           source: { vertical: 'crm', recorder: 'bot' } };
         CREATE knowledge_fact CONTENT { entityId: $copy, predicate: 'pilot_launch_date', object: '2026-05-06',
           confidence: 0.9, validFrom: d'2026-03-18T00:00:00Z', status: 'active', userId: $u,
           source: { vertical: 'crm', recorder: 'bot' } };
         CREATE knowledge_fact CONTENT { entityId: $orphan, predicate: 'batch_size', object: '200',
           confidence: 0.9, validFrom: d'2026-03-18T00:00:00Z', status: 'active', userId: $u,
           source: { vertical: 'crm', recorder: 'bot' } };
         RELATE $copy->knowledge_edge->$acme CONTENT { kind: 'monitored_by', weight: 1.0, source: { vertical: 'crm' }, userId: $u };`,
        {
          copy: new StringRecordId(ledgerCopy),
          orphan: new StringRecordId(orphanCopy),
          acme: new StringRecordId(acme),
          u: A,
        },
      );
    });
    // The user's own node, written the way the app writes it.
    await fact({
      entityRef: { vertical: 'user', id: A },
      predicate: 'timezone',
      object: 'Europe/Lisbon',
      validFrom: '2026-01-01',
      userId: A,
    });

    const svc = f.app.get(ScopedEntityConsolidationService);
    const first = await svc.consolidate(f.companyId);
    expect(first).toMatchObject({
      scanned: 2,
      merged: 1,
      rekeyed: 1,
      factsMoved: 2,
      edgesMoved: 1,
      // The copy's active 2026-05-06 met the mention's 2026-05-06 in one
      // scope: one record, one corroboration.
      duplicatesFolded: 1,
    });

    // The timeline of the tenant node is whole: the earlier stage is back.
    const history = await timelineObjects(ledgerShared, A);
    expect(history).toContain('pilot_launch_date=2026-04-15');
    expect(history).toContain('pilot_launch_date=2026-05-06');
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ object: string; status: string }>]>(
        `SELECT object, status FROM knowledge_fact
          WHERE entityId = $id AND predicate = 'pilot_launch_date' ORDER BY object, status`,
        { id: new StringRecordId(ledgerShared) },
      );
      // One record per value in one scope: the copy's 2026-05-06 became a
      // corroboration of the mention's, the 2026-04-15 stage kept its
      // superseded status.
      expect(rows).toEqual([
        { object: '2026-04-15', status: 'superseded' },
        { object: '2026-05-06', status: 'active' },
        { object: '2026-05-06', status: 'corroborating' },
      ]);
    });

    await surreal.withCompany(f.companyId, async (db) => {
      const [copyRow] = await db.query<[Array<{ mergedInto: unknown }>]>(
        `SELECT mergedInto FROM $id`,
        { id: new StringRecordId(ledgerCopy) },
      );
      expect(String((copyRow as Array<{ mergedInto: unknown }>)[0]!.mergedInto)).toBe(ledgerShared);
      // The edge now hangs off the tenant node, in the user's scope.
      const [edges] = await db.query<[Array<{ kind: string; userId: string }>]>(
        `SELECT kind, userId FROM $id->knowledge_edge ORDER BY kind`,
        { id: new StringRecordId(ledgerShared) },
      );
      expect(edges).toEqual([
        { kind: 'deploys_to', userId: A },
        { kind: 'monitored_by', userId: A },
      ]);
      // The orphan is the tenant node for its reference now.
      const [orphan] = await db.query<
        [Array<{ userId: string | null; scope: string[]; externalRefs: Record<string, string> }>]
      >(`SELECT userId, scope, externalRefs FROM $id`, { id: new StringRecordId(orphanCopy) });
      const o = (orphan as Array<Record<string, unknown>>)[0]!;
      expect(o.userId ?? null).toBeNull();
      expect(o.scope).toEqual([]);
      expect(o.externalRefs).toEqual({ 'crm__zeta-batch': 'zeta-batch' });
      const [refs] = await db.query<[Array<{ key: string }>]>(
        `SELECT key FROM entity_external_ref WHERE string::contains(key, '::u::') ORDER BY key`,
      );
      // Only the user's own node keeps a scoped key.
      expect((refs as Array<{ key: string }>).map((r) => r.key)).toEqual([`user__${A}::u::${A}`]);
    });

    // A second pass has nothing to do.
    expect(await svc.consolidate(f.companyId)).toMatchObject({ scanned: 0 });
    // And a fresh scoped write by reference lands on the tenant node.
    const again = await fact({
      entityRef: { vertical: 'crm', id: 'zeta-batch' },
      predicate: 'batch_size',
      object: '250',
      validFrom: '2026-04-01',
      userId: B,
    });
    expect(await entityOfFact(again.factId)).toBe(orphanCopy);
  });

  it('user-forget after the fold erases the user’s facts and no shared node', async () => {
    const r = await f.http.post(`/v1/users/${A}/forget`).set(auth()).send({});
    expect([200, 201]).toContain(r.status);
    // The user's own node and the merged copy's redirect husk go (both
    // carry the user's scope); the shared nodes stay.
    expect(r.body.entitiesDeleted).toBe(2);
    await surreal.withCompany(f.companyId, async (db) => {
      const [left] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM knowledge_fact WHERE userId = $u GROUP ALL`,
        { u: A },
      );
      expect((left as Array<{ n: number }>)[0]?.n ?? 0).toBe(0);
      const [nodes] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_entity WHERE id IN $ids`,
        { ids: [new StringRecordId(ledgerShared), new StringRecordId(orphanCopy)] },
      );
      expect((nodes as Array<{ id: unknown }>).length).toBe(2);
    });
    // B's fact on the former orphan survives.
    expect(await timelineObjects(orphanCopy, B)).toEqual(['batch_size=250']);
  });
});
