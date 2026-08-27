/**
 * GDPR forget × the Source layer (regression for the document-cascade
 * gap): both forget services cascaded many tables but never touched
 * source_document / source_chunk / candidate / indexer_run — chunk text
 * and candidate payloads carrying the forgotten subject's words survived
 * every erase. The gap lived because no forget e2e ever SEEDED those
 * tables; this spec seeds them.
 *
 * Contract under test (fact-mediated — see document-purge.util.ts):
 *   * EXCLUSIVE doc (only the subject's committed facts reference it) →
 *     doc + chunks + candidates + indexer_runs fully erased, counters
 *     stamped (tombstone for entity-forget, result for user-forget);
 *   * SHARED doc (another subject still grounds facts in it) → survives
 *     WITH content — the documented limit this spec pins;
 *   * defensive candidate sweep (entity-forget): id-bearing candidate
 *     payloads die even when their doc survives;
 *   * chunkCount feeds the FORGET_MAX_TX_RECORDS guard (413, pre-mutation);
 *   * idempotent replay on the same requestId stays a no-op.
 */
import { StringRecordId } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

type Db = Parameters<Parameters<SurrealService['withCompany']>[1]>[0];

describe('GDPR forget — source-document cascade', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const surreal = () => f.app.get(SurrealService);

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_doc_cascade_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const createRow = async (db: Db, sql: string, params?: Record<string, unknown>) => {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(sql, params);
    return String((rows as Array<{ id: unknown }>)[0]!.id);
  };

  /** Seed one source_document + chunks + indexer_run + candidate. */
  const seedDoc = async (
    db: Db,
    opts: { hash: string; chunkTexts: string[]; candidatePayload?: Record<string, unknown> },
  ) => {
    const docId = await createRow(
      db,
      `CREATE source_document SET kind='note', contentHash=$h, charLen=100,
         chunkCount=$n, vertical='rent', occurredAt=time::now(), status='indexed'
       RETURN id`,
      { h: opts.hash, n: opts.chunkTexts.length },
    );
    const doc = new StringRecordId(docId);
    const chunkIds: string[] = [];
    for (let seq = 0; seq < opts.chunkTexts.length; seq++) {
      chunkIds.push(
        await createRow(
          db,
          `CREATE source_chunk SET docId=$doc, seq=$seq, text=$t, charStart=0, charEnd=10 RETURN id`,
          { doc, seq, t: opts.chunkTexts[seq] },
        ),
      );
    }
    const runId = await createRow(
      db,
      `CREATE indexer_run SET docId=$doc, packId='p', packVersion='1', status='succeeded' RETURN id`,
      { doc },
    );
    let candidateId: string | undefined;
    if (opts.candidatePayload) {
      candidateId = await createRow(
        db,
        `CREATE candidate SET docId=$doc, runId=$run, chunkSeq=0, kind='fact',
           payload=$p, confidence=0.9, status='committed' RETURN id`,
        { doc, run: new StringRecordId(runId), p: opts.candidatePayload },
      );
    }
    return { docId, chunkIds, runId, candidateId };
  };

  const seedEntity = async (db: Db, name: string, userId?: string) =>
    createRow(
      db,
      `CREATE knowledge_entity SET type='other', canonicalName=$n, externalRefs={}
         ${userId ? ', userId=$u' : ''} RETURN id`,
      userId ? { n: name, u: userId } : { n: name },
    );

  const seedFact = async (
    db: Db,
    opts: { entityId: string; object: string; docId: string; userId?: string },
  ) =>
    createRow(
      db,
      `CREATE knowledge_fact SET entityId=$ent, predicate='note', object=$obj,
         confidence=0.9, validFrom=time::now()${opts.userId ? ', userId=$u' : ''},
         source={ recorder: 'test', documentId: $doc } RETURN id`,
      {
        ent: new StringRecordId(opts.entityId),
        obj: opts.object,
        doc: opts.docId,
        ...(opts.userId ? { u: opts.userId } : {}),
      },
    );

  /** How many of the given record ids still exist (id-addressed — survives dangling links). */
  const surviving = (ids: string[]) =>
    surreal().withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM $ids`, {
        ids: ids.map((id) => new StringRecordId(id)),
      });
      return ((rows as Array<{ id: unknown }>) ?? []).length;
    });

  const tombstoneFor = (requestId: string) =>
    surreal().withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT purgedSourceDocs, purgedSourceChunks, purgedCandidates, purgedIndexerRuns
           FROM forgotten_entity WHERE requestId = $r`,
        { r: requestId },
      );
      return (rows as Array<Record<string, unknown>>) ?? [];
    });

  let firstEntityId = '';

  it('entity-forget erases an EXCLUSIVE doc with chunks, candidates and indexer runs', async () => {
    const seeded = await surreal().withCompany(f.companyId, async (db) => {
      const entityId = await seedEntity(db, 'Doc Subject One');
      const doc = await seedDoc(db, {
        hash: 'cascade-hash-exclusive-1',
        chunkTexts: ['subject one private text A', 'subject one private text B'],
        candidatePayload: { entityId, object: 'subject one private claim' },
      });
      await seedFact(db, { entityId, object: 'private-object', docId: doc.docId });
      return { entityId, ...doc };
    });
    firstEntityId = seeded.entityId;

    const forget = await f.http
      .post(`/v1/entities/${encodeURIComponent(seeded.entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-doc-cascade-1' });
    expect([200, 201]).toContain(forget.status);

    // Every Source-layer row of the exclusive doc is gone BY CAPTURED ID.
    expect(
      await surviving([seeded.docId, ...seeded.chunkIds, seeded.runId, seeded.candidateId!]),
    ).toBe(0);

    // Tombstone counters match the seeded fan-out.
    const tombs = await tombstoneFor('req-doc-cascade-1');
    expect(tombs).toHaveLength(1);
    expect(tombs[0]).toEqual({
      purgedSourceDocs: 1,
      purgedSourceChunks: 2,
      purgedCandidates: 1,
      purgedIndexerRuns: 1,
    });
  });

  it('entity-forget replay on the same requestId is a stored-result no-op', async () => {
    // The entity is already erased; the same (requestId, entity) pair must
    // replay the stored tombstone — no 404, no re-erase, ONE tombstone.
    const replay = await f.http
      .post(`/v1/entities/${encodeURIComponent(firstEntityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-doc-cascade-1' });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.factsDeleted).toBe(1);
    expect(await tombstoneFor('req-doc-cascade-1')).toHaveLength(1);
  });

  it('entity-forget leaves a SHARED doc untouched but sweeps id-bearing candidates', async () => {
    const seeded = await surreal().withCompany(f.companyId, async (db) => {
      const subjectId = await seedEntity(db, 'Doc Subject Two');
      const otherId = await seedEntity(db, 'Doc Bystander');
      const doc = await seedDoc(db, {
        hash: 'cascade-hash-shared-1',
        chunkTexts: ['shared doc text'],
        candidatePayload: { entityId: subjectId, object: 'subject two claim' },
      });
      const subjectFactId = await seedFact(db, {
        entityId: subjectId,
        object: 'subject-two-object',
        docId: doc.docId,
      });
      const otherFactId = await seedFact(db, {
        entityId: otherId,
        object: 'bystander-object',
        docId: doc.docId,
      });
      return { subjectId, otherFactId, subjectFactId, ...doc };
    });

    const forget = await f.http
      .post(`/v1/entities/${encodeURIComponent(seeded.subjectId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-doc-cascade-2' });
    expect([200, 201]).toContain(forget.status);

    // Documented limit, pinned: the shared doc + its chunks + the other
    // subject's fact SURVIVE (no per-chunk attribution to erase).
    expect(await surviving([seeded.docId, ...seeded.chunkIds, seeded.otherFactId])).toBe(3);
    // The subject's own fact is gone.
    expect(await surviving([seeded.subjectFactId])).toBe(0);
    // The defensive sweep still killed the id-bearing candidate.
    expect(await surviving([seeded.candidateId!])).toBe(0);
    const tombs = await tombstoneFor('req-doc-cascade-2');
    expect(tombs[0]).toEqual({
      purgedSourceDocs: 0,
      purgedSourceChunks: 0,
      purgedCandidates: 1,
      purgedIndexerRuns: 0,
    });
  });

  it('entity-forget refuses (413) when the doc chunk fan-out exceeds the tx cap', async () => {
    const seeded = await surreal().withCompany(f.companyId, async (db) => {
      const entityId = await seedEntity(db, 'Doc Subject Cap');
      // chunkCount COLUMN drives the pre-mutation accounting — no need to
      // materialise 20001 chunk rows.
      const docId = await createRow(
        db,
        `CREATE source_document SET kind='note', contentHash='cascade-hash-cap-1',
           charLen=100, chunkCount=20001, vertical='rent', occurredAt=time::now(),
           status='indexed' RETURN id`,
      );
      const factId = await seedFact(db, { entityId, object: 'cap-object', docId });
      return { entityId, docId, factId };
    });

    const forget = await f.http
      .post(`/v1/entities/${encodeURIComponent(seeded.entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-doc-cascade-cap' });
    expect(forget.status).toBe(413);
    // Refusal is PRE-MUTATION: nothing was erased.
    expect(await surviving([seeded.entityId, seeded.docId, seeded.factId])).toBe(3);
  });

  it('user-forget erases an EXCLUSIVE doc and reports the counters', async () => {
    const u = 'user_doc_cascade_a';
    const seeded = await surreal().withCompany(f.companyId, async (db) => {
      const entityId = await seedEntity(db, 'User Doc Entity', u);
      const doc = await seedDoc(db, {
        hash: 'cascade-hash-user-1',
        chunkTexts: ['user a private text'],
        candidatePayload: { object: 'user a claim' },
      });
      await seedFact(db, { entityId, object: 'user-a-object', docId: doc.docId, userId: u });
      return doc;
    });

    const forget = await f.http.post(`/v1/users/${u}/forget`).set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body.purgedSourceDocs).toBe(1);
    expect(forget.body.purgedSourceChunks).toBe(1);
    expect(forget.body.purgedCandidates).toBe(1);
    expect(forget.body.purgedIndexerRuns).toBe(1);
    expect(
      await surviving([seeded.docId, ...seeded.chunkIds, seeded.runId, seeded.candidateId!]),
    ).toBe(0);
  });

  it('user-forget leaves a doc SHARED with a global fact untouched', async () => {
    const u = 'user_doc_cascade_b';
    const seeded = await surreal().withCompany(f.companyId, async (db) => {
      const personal = await seedEntity(db, 'User B Entity', u);
      const global = await seedEntity(db, 'Global Doc Entity');
      const doc = await seedDoc(db, {
        hash: 'cascade-hash-user-2',
        chunkTexts: ['shared with tenant text'],
      });
      await seedFact(db, {
        entityId: personal,
        object: 'user-b-object',
        docId: doc.docId,
        userId: u,
      });
      // A GLOBAL (no-userId) fact counts as another subject → SHARED.
      const globalFactId = await seedFact(db, {
        entityId: global,
        object: 'tenant-object',
        docId: doc.docId,
      });
      return { globalFactId, ...doc };
    });

    const forget = await f.http.post(`/v1/users/${u}/forget`).set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body.purgedSourceDocs).toBe(0);
    expect(forget.body.purgedSourceChunks).toBe(0);
    // Documented limit, pinned: doc + chunks + the tenant's fact survive.
    expect(await surviving([seeded.docId, ...seeded.chunkIds, seeded.globalFactId])).toBe(3);
  });
});
