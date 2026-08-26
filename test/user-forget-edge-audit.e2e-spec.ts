/**
 * GDPR completeness (audit wave E): knowledge_edge is mirrored into
 * audit_event by the changefeed drain, so user-forget must purge the
 * edge's audit rows too — not just the fact/entity ones. This seeds a
 * personal entity, an edge on it, and a matching audit_event mirror row,
 * then asserts forget erases all three.
 */
import { StringRecordId } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('user-forget purges edge audit_event rows', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_forget_edge_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('erases the audit_event mirror of a forgotten user’s edge', async () => {
    const surreal = f.app.get(SurrealService);
    const seeded = await surreal.withCompany(f.companyId, async (db) => {
      // A personal entity for user_x and a global one to point at.
      const [personal] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity SET type='other', canonicalName='Personal X',
           externalRefs={}, userId='user_x' RETURN id`,
      );
      const [global] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity SET type='other', canonicalName='Global Y',
           externalRefs={} RETURN id`,
      );
      const pid = String((personal as Array<{ id: unknown }>)[0]!.id);
      const gid = String((global as Array<{ id: unknown }>)[0]!.id);

      // An edge whose `in` endpoint is the personal entity — user-forget
      // matches it via in.userId = $u. knowledge_edge is TYPE RELATION,
      // so it must be created with RELATE (bound record ids, per
      // edge-writer.ts).
      const [edge] = await db.query<[Array<{ id: unknown }>]>(
        `RELATE $from->knowledge_edge->$to
           CONTENT { kind: 'related_to', weight: 1.0, source: {} } RETURN AFTER`,
        { from: new StringRecordId(pid), to: new StringRecordId(gid) },
      );
      const eid = String((edge as Array<{ id: unknown }>)[0]!.id);

      // The changefeed mirror row the drain would have written for it.
      await db.query(
        `CREATE audit_event SET source='changefeed', recordId=$rid,
           op='create', versionstamp=1, consumedBy='test'`,
        { rid: eid },
      );

      // A personal fact + its retrieval_feedback row: the feedback DELETE
      // traverses compound-covered factId — the SurrealDB 3.2.4 planner
      // no-op shape (see preSweepOutcomeRows, PR #372). Capture the ids
      // BEFORE the forget: afterwards the factId link dangles, so a
      // traversal count reads 0 whether or not the rows really died.
      const [fact] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_fact SET entityId=$ent, predicate='note', object='secret-pii',
           confidence=0.9, validFrom=time::now(), userId='user_x',
           source={ recorder: 'test' } RETURN id`,
        { ent: new StringRecordId(pid) },
      );
      const factId = (fact as Array<{ id: unknown }>)[0]!.id;
      const [feedback] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE retrieval_feedback SET factId=$f, verdict='helpful', actor='reviewer-1',
           reason='secret-pii' RETURN id`,
        { f: factId },
      );
      return {
        edgeId: eid,
        feedbackId: String((feedback as Array<{ id: unknown }>)[0]!.id),
      };
    });
    const edgeId = seeded.edgeId;

    const countAudit = () =>
      surreal.withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[Array<{ n: number }>]>(
          `SELECT count() AS n FROM audit_event WHERE recordId = $rid GROUP ALL`,
          { rid: edgeId },
        );
        return (rows as Array<{ n: number }>)[0]?.n ?? 0;
      });

    expect(await countAudit()).toBe(1);

    const forget = await f.http.post('/v1/users/user_x/forget').set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body.edgesDeleted).toBeGreaterThanOrEqual(1);

    // The edge's audit mirror is gone with it.
    expect(await countAudit()).toBe(0);

    // The edge row and the fact-keyed feedback row must be gone BY THEIR
    // CAPTURED IDS — the reported counts and the traversal-based reads
    // both stay green through a 3.2.4 DELETE planner no-op (the rows
    // survive with dangling links), so only an id-addressed SELECT can
    // prove the erase landed.
    const remaining = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM $ids`, {
        ids: [new StringRecordId(edgeId), new StringRecordId(seeded.feedbackId)],
      });
      return (rows as Array<{ id: unknown }>).length;
    });
    expect(remaining).toBe(0);
  });
});
