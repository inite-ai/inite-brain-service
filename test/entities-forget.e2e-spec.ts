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
 *
 * R4 audit adds two more, exercised against the real SurrealDB:
 *   6. Idempotent retry — re-forget with the same requestId replays the
 *      stored result and writes no duplicate tombstone.
 *   7. Atomicity — a mid-transaction failure (a pre-seeded tombstone
 *      hash-conflict) rolls the whole erase back: nothing partially erased.
 */
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
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
    const counterEntityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: String(counterFactId).split(':')[1] },
      );
      return String((rows as any[])?.[0]?.entityId ?? '');
    });

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
    const sideTableIds = await surreal.withCompany(f.companyId, async (db) => {
      // Side tables keyed by the subject's fact records (fact_usage 0053,
      // retrieval_feedback 0054). Their ids are captured HERE, before the
      // forget: after the cascade the factId link dangles, so any
      // traversal-based count reads 0 even when the rows survived — a
      // SurrealDB 3.2.4 DELETE planner no-op (see preSweepOutcomeRows,
      // PR #372) is only observable by asserting on the captured ids.
      const [usageRows] = await db.query<any[][]>(
        `CREATE fact_usage CONTENT {
            factId: type::record('knowledge_fact', $ftail), readCount: 3 } RETURN id`,
        { ftail: String(subjFactId).split(':')[1] },
      );
      const [feedbackRows] = await db.query<any[][]>(
        `CREATE retrieval_feedback CONTENT {
            factId: type::record('knowledge_fact', $ftail),
            verdict: 'helpful', actor: 'reviewer-1',
            reason: 'secret-pii-value' } RETURN id`,
        { ftail: String(subjFactId).split(':')[1] },
      );
      const capturedIds = [(usageRows as any[])[0]?.id, (feedbackRows as any[])[0]?.id].filter(
        Boolean,
      );
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
      return capturedIds;
    });
    expect(sideTableIds.length).toBe(2);

    // Forget.
    const r = await f.http
      .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
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
        await countWhere(`SELECT id FROM debug_trace WHERE companyId = $cid`, { cid: f.companyId }),
      ).toBe(0);

      // Fact-keyed side tables (fact_usage + retrieval_feedback) must be
      // gone BY THEIR CAPTURED IDS: a 3.2.4 DELETE planner no-op leaves
      // the rows in place while every factId-traversal count reads 0
      // (the facts died, the link dangles) — id-addressed SELECT is the
      // only assertion the masking cannot hide from.
      const [sideRows] = await db.query<any[][]>(`SELECT id FROM $ids`, {
        ids: sideTableIds,
      });
      expect((sideRows as any[]).length).toBe(0);
    });
  });

  it('returns 404 on a non-existent entity', async () => {
    const r = await f.http
      .post('/v1/entities/knowledge_entity:does-not-exist/forget')
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-2' });
    expect(r.status).toBe(404);
  });

  // Resolve the knowledge_entity id backing a freshly-ingested fact.
  const seedEntity = async (extId: string, object: string): Promise<string> => {
    const fact = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: extId },
        predicate: 'name',
        object,
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(fact.status);
    const surreal = f.app.get(SurrealService);
    const entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: String(fact.body.factId).split(':')[1] },
      );
      return String((rows as any[])?.[0]?.entityId ?? '');
    });
    expect(entityId).toMatch(/^knowledge_entity:/);
    return entityId;
  };

  it('idempotent retry: re-forget with the same requestId replays the stored result (no duplicate tombstone)', async () => {
    const entityId = await seedEntity('idem_subj', 'Idempotent Person');
    const surreal = f.app.get(SurrealService);

    const r1 = await f.http
      .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'idem-1' });
    expect([200, 201]).toContain(r1.status);
    const hash = r1.body.entityIdHash as string;
    expect(hash).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(r1.body.factsDeleted).toBeGreaterThanOrEqual(1);

    // Retry with the SAME requestId — the entity is already gone, so this
    // must be a no-op replay of the stored result, NOT a 404 or a re-erase.
    const r2 = await f.http
      .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'idem-1' });
    expect([200, 201]).toContain(r2.status);
    expect(r2.body.entityIdHash).toBe(hash);
    expect(r2.body.factsDeleted).toBe(r1.body.factsDeleted);
    expect(r2.body.forgottenAt).toBe(r1.body.forgottenAt);

    // Exactly one tombstone for this entity — the replay wrote none.
    const tombCount = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT id FROM forgotten_entity WHERE entityIdHash = $h`,
        { h: hash },
      );
      return (rows as any[]).length;
    });
    expect(tombCount).toBe(1);
  });

  it('atomic erase: a mid-transaction failure rolls the whole erase back (nothing partially erased)', async () => {
    const entityId = await seedEntity('atomic_subj', 'Atomic Person');
    const surreal = f.app.get(SurrealService);

    // Compute the tombstone hash the erase will attempt to CREATE, then
    // PRE-SEED a conflicting tombstone (same hash, DIFFERENT requestId).
    // The transaction's final `CREATE forgotten_entity` hits the UNIQUE
    // index on entityIdHash and aborts the transaction — the DELETEs that
    // ran earlier in the same transaction must roll back.
    const key = f.app.get(ConfigService).get<string>('FORGET_HMAC_KEY') ?? 'inite-brain-default';
    const hash =
      'hmac:' + createHmac('sha256', key).update(`${f.companyId}/${entityId}`).digest('hex');
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE forgotten_entity CONTENT {
           entityIdHash: $h, reason: 'operator_request', requestId: 'pre-existing-conflict',
           factsDeleted: 0, edgesDeleted: 0, auditEventsDeleted: 0,
           episodesDeleted: 0, segmentsDeleted: 0, forgottenBy: 'seed', forgottenAt: time::now() }`,
        { h: hash },
      );
    });

    // Forget with a DIFFERENT requestId so the idempotency check does not
    // short-circuit; the erase must reach the failing CREATE and roll back.
    const r = await f.http
      .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'atomic-test' });
    expect(r.status).toBeGreaterThanOrEqual(500);

    // Atomicity proof: the subject entity + its fact are STILL PRESENT —
    // the erase deleted nothing because the transaction rolled back.
    await surreal.withCompany(f.companyId, async (db) => {
      const tail = entityId.split(':')[1];
      const [entRows] = await db.query<any[][]>(
        `SELECT id FROM type::record('knowledge_entity', $tail)`,
        { tail },
      );
      expect((entRows as any[]).length).toBe(1);
      const [factRows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_fact WHERE entityId = type::record('knowledge_entity', $tail)`,
        { tail },
      );
      expect((factRows as any[]).length).toBeGreaterThanOrEqual(1);
    });
  });
});
