/**
 * Per-user scope on knowledge_edge through the REAL write paths and read
 * surfaces (scripted extractor + scripted synthesize LLM, live SurrealDB):
 *  - POST /v1/ingest/mention with a userId stamps the extracted edges
 *    with that scope on BOTH routes — the mention-persist batched path
 *    (INGEST_BATCH_EDGES) and the document pipeline the production
 *    stand routes mentions through (INGEST_MENTION_VIA_DOCUMENT);
 *  - a replay of the same turn reuses the edge; the same relation from
 *    another user is that user's own row; a tenant-global turn keys on
 *    the empty scope;
 *  - the MCP twin find_related_entities honours userId like the HTTP
 *    connections route;
 *  - /v1/synthesize shows the asker their own relation and nobody else
 *    the personal one, and the answer cache keeps the two users apart.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { mockSynthesizeOpenAi } from './test-doubles';

interface EdgeRow {
  id: string;
  kind: string;
  userId: string | null;
  scopeKey: string;
  from: string;
  to: string;
}

describe('knowledge_edge scope through the ingest pipeline and the read surfaces', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const A = 'edge_user_a';
  const B = 'edge_user_b';

  beforeAll(async () => {
    // The document route needs the document surface; the mention route
    // is picked per test through INGEST_MENTION_VIA_DOCUMENT.
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    f = await createApp({ companyId: `co_edgepipe_${Date.now()}` });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    delete process.env.INGEST_BATCH_EDGES;
    if (f) await f.close();
  });

  /** The extractor's reading of "Maria works at Orbital Dynamics". */
  const scriptWorksAt = () =>
    f.extractor.setScript({
      entities: [
        { name: 'Maria Costa', type: 'staff' },
        { name: 'Orbital Dynamics', type: 'customer' },
      ],
      facts: [{ entityIndex: 0, predicate: 'role', object: 'engineer', confidence: 0.9 }],
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'works_at', confidence: 0.9 }],
    });

  const mention = async (text: string, userId: string | undefined, messageId: string) => {
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        ...(userId ? { userId } : {}),
        contextRef: { vertical: 'chat', conversationId: `c-${userId ?? 'global'}`, messageId },
      });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toBe(false);
    return res.body as { extractedEntityIds: string[]; extractedEdgeIds: string[] };
  };

  const edgesOfKind = async (kind: string): Promise<EdgeRow[]> =>
    surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT id, kind, userId, scopeKey, in.canonicalName AS from, out.canonicalName AS to
           FROM knowledge_edge WHERE kind = $kind ORDER BY scopeKey`,
        { kind },
      );
      return (rows ?? []).map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        userId: (r.userId as string | undefined) ?? null,
        scopeKey: String(r.scopeKey),
        from: String(r.from),
        to: String(r.to),
      }));
    });

  const connections = async (entityId: string, userId?: string) => {
    const r = await f.http
      .get(`/v1/entities/${encodeURIComponent(entityId)}/connections`)
      .query(userId ? { userId } : {})
      .set(auth());
    expect(r.status).toBe(200);
    return (r.body.edges as Array<{ edgeId: string }>).map((e) => e.edgeId).sort();
  };

  let maria = '';
  let edgeA = '';
  let edgeB = '';
  let edgeGlobal = '';

  it('mention-persist (batched) stamps the turn’s scope on its edges and dedups within the scope', async () => {
    process.env.INGEST_MENTION_VIA_DOCUMENT = '0';
    process.env.INGEST_BATCH_EDGES = '1';
    scriptWorksAt();
    const first = await mention('Maria Costa works at Orbital Dynamics.', A, 'm1');
    expect(first.extractedEdgeIds).toHaveLength(1);
    edgeA = first.extractedEdgeIds[0]!;
    maria = first.extractedEntityIds[0]!;

    // Same turn again from the same user: the batched existence check
    // finds the edge in A's scope — no second row.
    const replay = await mention('Maria Costa works at Orbital Dynamics.', A, 'm2');
    expect(replay.extractedEdgeIds).toEqual([edgeA]);

    // The same relation told by another user is that user's own row.
    const theirs = await mention('Maria Costa works at Orbital Dynamics.', B, 'm3');
    expect(theirs.extractedEdgeIds).toHaveLength(1);
    edgeB = theirs.extractedEdgeIds[0]!;
    expect(edgeB).not.toBe(edgeA);

    // And a tenant-global turn keys on the empty scope.
    const global = await mention('Maria Costa works at Orbital Dynamics.', undefined, 'm4');
    edgeGlobal = global.extractedEdgeIds[0]!;
    expect(new Set([edgeA, edgeB, edgeGlobal]).size).toBe(3);

    const rows = await edgesOfKind('works_at');
    expect(rows.map((r) => [r.id, r.userId, r.scopeKey])).toEqual([
      [edgeGlobal, null, ''],
      [edgeA, A, A],
      [edgeB, B, B],
    ]);
    // All three sit on the same two shared entities — the scope is on the
    // edge, not on a copy of Maria.
    expect(new Set(rows.map((r) => `${r.from}→${r.to}`)).size).toBe(1);
  });

  it('the document pipeline (production route) stamps the scope the same way', async () => {
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    f.extractor.setScript({
      entities: [
        { name: 'Maria Costa', type: 'staff' },
        { name: 'Pedro Lima', type: 'staff' },
      ],
      facts: [],
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'mentors', confidence: 0.9 }],
    });
    const viaDoc = await mention('Maria Costa mentors Pedro Lima.', A, 'm5');
    expect(viaDoc.extractedEdgeIds).toHaveLength(1);
    const rows = await edgesOfKind('mentors');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: viaDoc.extractedEdgeIds[0], userId: A, scopeKey: A });
    // A replay of the same text by the same user is deduplicated at the
    // document store (content hash) — nothing new is committed and the
    // response says so, instead of claiming the extractor found nothing.
    const again = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text: 'Maria Costa mentors Pedro Lima.',
        userId: A,
        contextRef: { vertical: 'chat', conversationId: `c-${A}`, messageId: 'm6' },
      });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ skipped: true, reason: 'duplicate' });
    expect(await edgesOfKind('mentors')).toHaveLength(1);
    // The same relation from user B through the document route is B's row.
    const theirs = await mention('Maria Costa mentors Pedro Lima.', B, 'm7');
    expect(theirs.extractedEdgeIds).toHaveLength(1);
    const both = await edgesOfKind('mentors');
    expect(both.map((r) => [r.userId, r.scopeKey])).toEqual([
      [A, A],
      [B, B],
    ]);
    process.env.INGEST_MENTION_VIA_DOCUMENT = '0';
  });

  it('connections over HTTP and find_related_entities over MCP fence identically', async () => {
    const mentors = await edgesOfKind('mentors');
    const mentorsA = mentors.find((r) => r.userId === A)!.id;
    const mentorsB = mentors.find((r) => r.userId === B)!.id;
    expect(await connections(maria)).toEqual([edgeGlobal]);
    expect(await connections(maria, A)).toEqual([edgeA, edgeGlobal, mentorsA].sort());
    expect(await connections(maria, B)).toEqual([edgeB, edgeGlobal, mentorsB].sort());

    const mcp = async (userId?: string) => {
      const res = await f.http
        .post(`/mcp/${f.companyId}`)
        .set({ Authorization: `Bearer ${f.apiKey}`, Accept: 'application/json, text/event-stream' })
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'find_related_entities',
            arguments: { entityId: maria, ...(userId ? { userId } : {}) },
          },
        });
      expect(res.status).toBe(200);
      const text = res.text ?? '';
      const payload =
        text.startsWith('event:') || text.includes('data: ')
          ? JSON.parse(
              text
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .pop()!
                .slice(6),
            )
          : res.body;
      const edges = payload.result.structuredContent.edges as Array<{ edgeId: string }>;
      return edges.map((e) => e.edgeId).sort();
    };
    expect(await mcp()).toEqual([edgeGlobal]);
    expect(await mcp(A)).toEqual([edgeA, edgeGlobal, mentorsA].sort());
    expect(await mcp(B)).toEqual([edgeB, edgeGlobal, mentorsB].sort());
  });

  it('synthesize shows each asker their own relation; the answer cache keeps users apart', async () => {
    process.env.SYNTHESIZE_ANSWER_CACHE = '1';
    // A relation only A holds — the discriminating evidence line.
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    f.extractor.setScript({
      entities: [
        { name: 'Maria Costa', type: 'staff' },
        { name: 'Helix Labs', type: 'customer' },
      ],
      facts: [],
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'advises', confidence: 0.9 }],
    });
    await mention('Maria Costa advises Helix Labs.', A, 'm8');
    process.env.INGEST_MENTION_VIA_DOCUMENT = '0';
    const script = () =>
      mockSynthesizeOpenAi(f.app, [
        JSON.stringify({ answer: 'Maria Costa works at Orbital Dynamics.', citedFactIds: [] }),
        JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
      ]);
    const ask = async (userId?: string) => {
      const own = script();
      const res = await f.http
        .post('/v1/synthesize')
        .set(auth())
        .send({ query: 'Whom does Maria Costa advise?', limit: 10, ...(userId ? { userId } : {}) });
      expect(res.status).toBe(201);
      return {
        generator: own.calls[0]?.user ?? '',
        cached: res.body.cached === true,
        calls: own.calls.length,
      };
    };
    // A sees the advising relation in the evidence the generator gets.
    const a = await ask(A);
    expect(a.generator).toMatch(/advises.*Helix Labs/);
    // B does not — the personal relation of A is not in B's prompt, and
    // B's answer is synthesized afresh, not served from A's cache entry.
    const b = await ask(B);
    expect(b.calls).toBeGreaterThan(0);
    expect(b.generator).not.toMatch(/Helix Labs/);
    // No user at all: tenant-global evidence only.
    const nobody = await ask();
    expect(nobody.calls).toBeGreaterThan(0);
    expect(nobody.generator).not.toMatch(/Helix Labs/);
    delete process.env.SYNTHESIZE_ANSWER_CACHE;
  });
});
