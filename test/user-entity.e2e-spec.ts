/**
 * The user as an entity of their own memory, end to end on the real app
 * (scripted extractor, scripted synthesize LLM — no paid call):
 *  - a user-scoped mention with no speaker anchor files the extractor's
 *    first person under the user's own entity: personal (userId +
 *    scope tag), keyed `user__<id>::u::<id>`, named by the userId until
 *    a caller names it;
 *  - a later turn that anchors the user with a name renames the
 *    placeholder; the episode of that turn names its speaker;
 *  - /v1/synthesize with that userId tells the generator and the
 *    auditor who is asking; without a userId, or for a user who never
 *    spoke, it does not;
 *  - a typed fact on {vertical: 'user', id} under the same userId lands
 *    on the same node — one identity across both write paths.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { mockSynthesizeOpenAi } from './test-doubles';

interface EntityRow {
  id: unknown;
  canonicalName: string;
  aliases?: string[];
  userId?: string | null;
  scope?: string[];
}

describe("the user's own entity (user-entity.ts) end to end", () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const USER = 'user_42';

  async function userEntity(): Promise<EntityRow | null> {
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ entity: EntityRow }>]>(
        `SELECT entity.* AS entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
        { key: `user__${USER}::u::${USER}` },
      );
      return rows?.[0]?.entity ?? null;
    });
  }

  beforeAll(async () => {
    f = await createApp({ companyId: `co_userent_${Date.now()}` });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it("a first-person turn lands on the user's own personal entity, named by the userId for now", async () => {
    // What the real extractor does for "I moved to Berlin": a first-person
    // entity the coreference rule anchors to the speaker.
    f.extractor.setScript({
      entities: [
        { name: 'I', type: 'customer' },
        { name: 'Berlin', type: 'location' },
      ],
      facts: [{ entityIndex: 0, predicate: 'lives_in', object: 'Berlin', confidence: 0.9 }],
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'lives_at' }],
    });
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text: 'I moved to Berlin.',
        userId: USER,
        contextRef: { vertical: 'chat', conversationId: 'c-user', messageId: 'm1' },
      });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toBe(false);

    const row = await userEntity();
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(USER);
    expect(row!.scope).toEqual([`user:${USER}`]);
    // The pronoun names nothing; the userId stands in as the name.
    expect(row!.canonicalName).toBe(USER);
    expect(row!.aliases).not.toContain('I');
    expect(res.body.extractedEntityIds).toContain(String(row!.id));
  });

  it('a caller naming the user renames the placeholder, and the episode names its speaker', async () => {
    f.extractor.setScript({
      entities: [{ name: 'Sasha', type: 'customer' }],
      facts: [{ entityIndex: 0, predicate: 'drives', object: 'Skoda Octavia', confidence: 0.9 }],
      edges: [],
    });
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text: 'I drive a Skoda Octavia.',
        userId: USER,
        knownEntities: [{ vertical: 'user', id: USER, role: 'speaker', name: 'Sasha' }],
        contextRef: { vertical: 'chat', conversationId: 'c-user', messageId: 'm2' },
      });
    expect(res.status).toBe(201);
    const row = await userEntity();
    expect(row!.canonicalName).toBe('Sasha');
    expect(row!.aliases).toContain('Sasha');
    // One node, both turns.
    expect(res.body.extractedEntityIds).toEqual([String(row!.id)]);
    const speakers = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ speaker: string | null; messageId: string }>]>(
        `SELECT speaker, messageId FROM episode WHERE conversationId = 'c-user'`,
      );
      return Object.fromEntries((rows ?? []).map((r) => [r.messageId, r.speaker]));
    });
    expect(speakers).toEqual({ m1: USER, m2: 'Sasha' });
  });

  it('a typed fact on the user’s reference under the same userId lands on the same node', async () => {
    const row = await userEntity();
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'user', id: USER },
        userId: USER,
        predicate: 'timezone',
        object: 'Europe/Berlin',
        validFrom: new Date('2026-09-01').toISOString(),
        source: { vertical: 'chat', messageId: 'm3' },
        confidence: 0.9,
      });
    expect(res.status).toBe(201);
    const factEntity = await surreal.withCompany(f.companyId, async (db) => {
      const tail = String(res.body.factId).split(':')[1];
      const [rows] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM type::record('knowledge_fact', $t)`,
        { t: tail },
      );
      return String(rows?.[0]?.entityId);
    });
    expect(factEntity).toBe(String(row!.id));
  });

  it('synthesize names the asker for that user, and nobody else', async () => {
    const script = () =>
      mockSynthesizeOpenAi(f.app, [
        JSON.stringify({ answer: 'You live in Berlin.', citedFactIds: [] }),
        JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
      ]);
    const own = script();
    await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'Where do I live?', userId: USER });
    const generator = own.calls[0]?.user ?? '';
    expect(generator).toContain('Query: Where do I live?\nAsker: "Sasha" — the person asking.');
    const auditor = own.calls.find((c) => c.user.includes('Answer:'))?.user ?? '';
    expect(auditor).toContain('Asker: "Sasha" — the query\'s first person');

    const stranger = script();
    await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'Where do I live?', userId: 'user_99' });
    expect(stranger.calls.map((c) => c.user).join('\n')).not.toContain('Asker:');

    const global = script();
    await f.http.post('/v1/synthesize').set(auth()).send({ query: 'Where do I live?' });
    expect(global.calls.map((c) => c.user).join('\n')).not.toContain('Asker:');
  });
});
