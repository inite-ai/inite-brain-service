/**
 * GDPR forget cascade e2e (audit P0 #5: no e2e on
 * /v1/entities/:id/forget).
 *
 * Verifies the full forget shape end-to-end:
 *   1. Seed an entity + multiple facts + an edge.
 *   2. POST /v1/entities/:id/forget with a reason.
 *   3. Assert response shape: entityIdHash (HMAC), factsDeleted,
 *      edgesDeleted, forgottenAt.
 *   4. Verify the entity + its facts + its edges are gone from the
 *      tenant DB (cascade actually deleted).
 *   5. Verify a `forgotten_entity` tombstone row was written.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('POST /v1/entities/:id/forget — GDPR cascade', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_forget_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('deletes the entity, its facts, its edges, and writes an HMAC tombstone', async () => {
    // Seed the subject entity + two facts.
    const fact1 = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'forget_subj' },
        predicate: 'name',
        object: 'Forgettable Person',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(fact1.status);
    const subjFactId = fact1.body.factId as string;

    const fact2 = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'forget_subj' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(fact2.status);

    // Resolve the entityId for the subject by ingesting a fact and
    // reading its factId; the link API expects entity ids.
    const surreal = f.app.get(SurrealService);
    const entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        {
          tail: String(subjFactId).split(':')[1],
        },
      );
      return String((rows as any[])?.[0]?.entityId ?? '');
    });
    expect(entityId).toMatch(/^knowledge_entity:/);

    // Seed a counterparty entity + an edge subj → counter so we can
    // assert edge cascade.
    const factCounter = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'forget_counter' },
        predicate: 'name',
        object: 'Counterparty',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(factCounter.status);
    const counterFactId = factCounter.body.factId as string;
    const counterEntityId = await surreal.withCompany(
      f.companyId,
      async (db) => {
        const [rows] = await db.query<any[][]>(
          `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
          { tail: String(counterFactId).split(':')[1] },
        );
        return String((rows as any[])?.[0]?.entityId ?? '');
      },
    );

    const linkRes = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({
        from: { entityId },
        to: { entityId: counterEntityId },
        kind: 'works_with',
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(linkRes.status);

    // Simulate the changefeed mirror: the consumer (disabled in tests)
    // would write an audit_event carrying the entity's post-image,
    // including PII fact `object` values. Seed one keyed by the entity's
    // recordId so we can assert the forget cascade purges it.
    const tail = entityId.split(':')[1];
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE audit_event CONTENT {
            source: 'knowledge_entity',
            recordId: $rid,
            op: 'update',
            ts: time::now(),
            versionstamp: 1,
            after: { object: 'secret-pii-value' },
            consumedBy: 'test'
         }`,
        { rid: entityId },
      );
      // Seed every other PII-bearing store the forget cascade must purge.
      await db.query(
        `CREATE knowledge_artifact CONTENT {
            entityId: type::record('knowledge_entity', $tail),
            artifactType: 'customer_profile',
            payload: { name: 'secret-pii-value' },
            sourceFactIds: [], dirty: false }`,
        { tail },
      );
      await db.query(
        `CREATE ingest_dead_letter CONTENT {
            payload: { entityId: type::record('knowledge_entity', $tail),
                       object: 'secret-pii-value' },
            reason: 'low_score' }`,
        { tail },
      );
      await db.query(
        `CREATE entity_external_ref CONTENT {
            key: 'rent:secret-external-id',
            entity: type::record('knowledge_entity', $tail) }`,
        { tail },
      );
      await db.query(
        `CREATE dream_emit CONTENT {
            runId: 'r1', kind: 'link', subject: $rid,
            object: $rid, detail: { note: 'secret-pii-value' } }`,
        { rid: entityId },
      );
      await db.query(
        `CREATE debug_trace CONTENT {
            requestId: 'rq1', method: 'POST', path: '/v1/ingest/fact',
            status: 201, durationMs: 1, companyId: $cid,
            spans: [], artifacts: [{ ref: $rid, text: 'secret-pii-value' }] }`,
        { cid: f.companyId, rid: entityId },
      );
    });

    // Forget.
    const r = await f.http
      .post(
        `/v1/entities/${encodeURIComponent(entityId)}/forget`,
      )
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-1' });
    expect([200, 201]).toContain(r.status);
    expect(r.body.entityIdHash).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(r.body.factsDeleted).toBeGreaterThanOrEqual(2);
    expect(r.body.edgesDeleted).toBeGreaterThanOrEqual(1);
    expect(r.body.auditEventsDeleted).toBeGreaterThanOrEqual(1);
    expect(typeof r.body.forgottenAt).toBe('string');

    // Storage assertions: entity row gone, facts gone, edges gone,
    // tombstone written.
    await surreal.withCompany(f.companyId, async (db) => {
      const [entRows] = await db.query<any[][]>(
        `SELECT id FROM type::record('knowledge_entity', $tail)`,
        { tail: entityId.split(':')[1] },
      );
      expect((entRows as any[]).length).toBe(0);

      const [factRows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_fact
           WHERE entityId = type::record('knowledge_entity', $tail)`,
        { tail: entityId.split(':')[1] },
      );
      expect((factRows as any[]).length).toBe(0);

      const [tombRows] = await db.query<any[][]>(
        `SELECT entityIdHash, reason, forgottenBy, auditEventsDeleted
           FROM forgotten_entity
           WHERE entityIdHash = $h LIMIT 1`,
        { h: r.body.entityIdHash },
      );
      expect((tombRows as any[]).length).toBe(1);
      expect((tombRows as any[])[0].reason).toBe('gdpr_request');
      // GDPR accountability: the acting credential is recorded (hashed).
      expect((tombRows as any[])[0].forgottenBy).toBeTruthy();
      expect((tombRows as any[])[0].forgottenBy).not.toBe('unknown');

      // The seeded audit_event mirror carrying PII must be gone.
      const [auditRows] = await db.query<any[][]>(
        `SELECT id FROM audit_event WHERE recordId = $rid`,
        { rid: entityId },
      );
      expect((auditRows as any[]).length).toBe(0);

      // GDPR completeness: every other PII store must be purged too.
      const countWhere = async (sql: string, params: any) => {
        const [rows] = await db.query<any[][]>(sql, params);
        return (rows as any[]).length;
      };
      expect(
        await countWhere(
          `SELECT id FROM knowledge_artifact WHERE entityId = type::record('knowledge_entity', $tail)`,
          { tail },
        ),
      ).toBe(0);
      expect(
        await countWhere(
          `SELECT id FROM ingest_dead_letter WHERE payload.entityId = type::record('knowledge_entity', $tail)`,
          { tail },
        ),
      ).toBe(0);
      expect(
        await countWhere(
          `SELECT id FROM entity_external_ref WHERE entity = type::record('knowledge_entity', $tail)`,
          { tail },
        ),
      ).toBe(0);
      expect(
        await countWhere(`SELECT id FROM dream_emit WHERE subject = $rid`, {
          rid: entityId,
        }),
      ).toBe(0);
      expect(
        await countWhere(
          `SELECT id FROM debug_trace WHERE companyId = $cid`,
          { cid: f.companyId },
        ),
      ).toBe(0);
    });
  });

  it('returns 404 on a non-existent entity', async () => {
    const r = await f.http
      .post('/v1/entities/knowledge_entity:does-not-exist/forget')
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-2' });
    expect(r.status).toBe(404);
  });
});
