/**
 * User forget erases the facts Brain refused about the user, against a
 * real SurrealDB. A refused fact (ingest_dead_letter) keeps the claim's
 * text and no userId, so before this it outlived the user: the forget
 * reached it only through entity forget. Now it goes when it names the
 * user's own entity or comes from a document stamped with the user;
 * another user's refused facts, and a tenant-wide one, stay.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('user forget — refused facts (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_forget_dead_letters_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const surreal = () => f.app.get(SurrealService);

  /** The user's own entity, made by a personal fact about them. */
  const personalEntity = async (userId: string): Promise<string> => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'user', id: userId },
        predicate: 'name',
        object: `Name of ${userId}`,
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        userId,
      });
    expect([200, 201]).toContain(r.status);
    return surreal().withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM knowledge_entity WHERE userId = $u`,
        { u: userId },
      );
      expect(rows.length).toBeGreaterThan(0);
      return String(rows[0]);
    });
  };

  /** A document stamped with the user. */
  const userDocument = async (userId: string): Promise<string> => {
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'chat',
        text: `${userId}: a day of chat`,
        occurredAt: new Date().toISOString(),
        originUri: `test:chat:${userId}`,
        contextRef: { vertical: 'rent', recorder: 'bot' },
        userId,
        mode: 'sync',
      });
    expect([200, 201]).toContain(r.status);
    expect(r.body.documentId).toBeTruthy();
    return String(r.body.documentId);
  };

  const refuse = (payload: string, params: Record<string, unknown>) =>
    surreal().withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE ingest_dead_letter CONTENT { payload: ${payload}, reason: 'low_score' } RETURN id`,
        params,
      );
      return String(rows[0]!.id);
    });

  const alive = (ids: string[]) =>
    surreal().withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(`SELECT VALUE id FROM ingest_dead_letter`);
      const present = new Set(rows.map(String));
      return ids.filter((id) => present.has(id));
    });

  it('erases refused facts on the user’s entity and from the user’s documents only', async () => {
    const goneEntity = await personalEntity('u_dl_gone');
    const keptEntity = await personalEntity('u_dl_kept');
    const goneDoc = await userDocument('u_dl_gone');
    const keptDoc = await userDocument('u_dl_kept');

    const onEntity = (entity: string, object: string) =>
      refuse(`{ entityId: type::record($e), object: $o, source: { vertical: 'rent' } }`, {
        e: entity,
        o: object,
      });
    const fromDocRecord = (doc: string, object: string) =>
      refuse(`{ object: $o, source: { vertical: 'rent', documentId: type::record($d) } }`, {
        d: doc,
        o: object,
      });
    const fromDocString = (doc: string, object: string) =>
      refuse(`{ object: $o, source: { vertical: 'rent', documentId: $d } }`, { d: doc, o: object });

    const gone = [
      await onEntity(goneEntity, 'secret of u_dl_gone'),
      await fromDocRecord(goneDoc, 'secret from the document'),
      await fromDocString(goneDoc, 'secret from the document, string id'),
    ];
    const kept = [
      await onEntity(keptEntity, 'secret of u_dl_kept'),
      await fromDocRecord(keptDoc, 'kept from the document'),
      await refuse(`{ object: 'tenant-wide', source: { vertical: 'rent' } }`, {}),
    ];

    const forget = await f.http.post('/v1/users/u_dl_gone/forget').set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body.deadLettersDeleted).toBe(3);

    expect(await alive(gone)).toEqual([]);
    expect((await alive(kept)).sort()).toEqual([...kept].sort());
  });
});
