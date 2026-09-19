/**
 * Per-user scope on knowledge_edge (migrations 0153/0154) against a REAL
 * SurrealDB: an edge carries the scope of the turn that wrote it, is
 * unique within its scope (the tenant-global edge and a user's personal
 * edge of one triple are two rows; a second personal write returns the
 * first), and every relation read is fail-closed — the connections
 * surface and the search hits' `relations` show a caller tenant-global
 * edges plus their own, never another user's.
 */
import { AppFixture, createApp } from './app-fixture';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { createEdgeBetween } from '../src/ingest/edge-writer';

describe('per-user scope on knowledge_edge', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_edge_scope_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const mint = async (id: string, name: string): Promise<string> => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'crm', id },
        predicate: 'name',
        object: name,
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'crm', recorder: 'bot' },
      });
    expect([200, 201]).toContain(r.status);
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: (r.body.factId as string).split(':')[1] },
      );
      return String((rows as Array<{ entityId: unknown }>)[0]!.entityId);
    });
  };

  const connections = async (entityId: string, userId?: string) => {
    const r = await f.http
      .get(`/v1/entities/${encodeURIComponent(entityId)}/connections`)
      .query(userId ? { userId } : {})
      .set(auth());
    expect(r.status).toBe(200);
    return (r.body.edges as Array<{ edgeId: string; kind: string }>).map((e) => e.edgeId);
  };

  const searchRelations = async (query: string, userId?: string) => {
    const r = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query, limit: 10, ...(userId ? { userId } : {}) });
    expect(r.status).toBe(201);
    return (r.body.results as Array<{ relations?: Array<{ edgeId: string }> }>)
      .flatMap((h) => h.relations ?? [])
      .map((rel) => rel.edgeId);
  };

  let maria: string;
  let orbital: string;
  let globalEdge: string;
  let personalEdge: string;
  /** A relation user_a alone holds — no tenant-global twin. */
  let personalOnlyEdge: string;

  it('one triple, one row per scope; a repeat within a scope returns the first', async () => {
    maria = await mint('edge_scope_maria', 'Maria Edge Scope');
    orbital = await mint('edge_scope_orbital', 'Orbital Edge Scope');
    const source = { vertical: 'crm', eventId: 'ev_edge_scope' };
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const write = (userId?: string) =>
        createEdgeBetween(db, {
          fromEntityId: maria,
          toEntityId: orbital,
          kind: 'works_at',
          source,
          userId,
        });
      globalEdge = (await write()) as string;
      personalEdge = (await write('user_a')) as string;
      expect(globalEdge).toBeTruthy();
      expect(personalEdge).toBeTruthy();
      expect(personalEdge).not.toBe(globalEdge);
      // Idempotent within the scope — both the global and the personal
      // repeat resolve to their own existing row.
      expect(await write()).toBe(globalEdge);
      expect(await write('user_a')).toBe(personalEdge);
      personalOnlyEdge = (await createEdgeBetween(db, {
        fromEntityId: maria,
        toEntityId: orbital,
        kind: 'mentors_at',
        source,
        userId: 'user_a',
      })) as string;
      expect(personalOnlyEdge).toBeTruthy();

      const [rows] = await db.query<
        [Array<{ id: unknown; userId: string | null; scopeKey: string }>]
      >(
        `SELECT id, userId, scopeKey FROM knowledge_edge WHERE in = $m AND out = $o AND kind = 'works_at' ORDER BY scopeKey`,
        { m: recordOf(maria), o: recordOf(orbital) },
      );
      const got = (rows as Array<{ id: unknown; userId: string | null; scopeKey: string }>).map(
        (r) => ({ id: String(r.id), userId: r.userId ?? null, scopeKey: r.scopeKey }),
      );
      expect(got).toEqual([
        { id: globalEdge, userId: null, scopeKey: '' },
        { id: personalEdge, userId: 'user_a', scopeKey: 'user_a' },
      ]);
    });
  });

  it('connections: tenant-global to everyone, the personal edges to their user only', async () => {
    const own = [globalEdge, personalEdge, personalOnlyEdge].sort();
    expect(await connections(maria)).toEqual([globalEdge]);
    expect((await connections(maria, 'user_a')).sort()).toEqual(own);
    expect(await connections(maria, 'user_b')).toEqual([globalEdge]);
    // Seen from the far end as well.
    expect((await connections(orbital, 'user_a')).sort()).toEqual(own);
    expect(await connections(orbital, 'user_b')).toEqual([globalEdge]);
  });

  it('search relations follow the same fence', async () => {
    const none = await searchRelations('Maria Edge Scope');
    const mine = await searchRelations('Maria Edge Scope', 'user_a');
    const theirs = await searchRelations('Maria Edge Scope', 'user_b');
    // A hit renders one relation line per (peer, kind, direction), so the
    // global works_at and user_a's personal twin collapse to one line —
    // either id is that relation. The personal-only relation is the
    // discriminating one: its user sees it, nobody else does.
    expect(none).toContain(globalEdge);
    expect(none).not.toContain(personalOnlyEdge);
    expect(mine).toContain(personalOnlyEdge);
    expect(theirs).toContain(globalEdge);
    expect(theirs).not.toContain(personalEdge);
    expect(theirs).not.toContain(personalOnlyEdge);
  });

  it('user forget takes the personal edges with it and leaves the global one', async () => {
    const r = await f.http.post('/v1/users/user_a/forget').set(auth()).send({});
    expect([200, 201]).toContain(r.status);
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_edge WHERE in = $m AND out = $o AND kind = 'works_at'`,
        { m: recordOf(maria), o: recordOf(orbital) },
      );
      expect((rows as Array<{ id: unknown }>).map((x) => String(x.id))).toEqual([globalEdge]);
    });
  });
});

const recordOf = (id: string) => new StringRecordId(id);
