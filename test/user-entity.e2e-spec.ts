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
 *    on the same node — one identity across both write paths;
 *  - the memory learns the user's name from a `name` fact — the user's
 *    own words or an onboarding write — and the entity's canonical name
 *    follows it (entity-name.ts); the profile API reports the identity;
 *  - in the asker's own prompts their entity is headed "you".
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
    process.env.USER_PROFILE_API_ENABLED = '1';
    f = await createApp({ companyId: `co_userent_${Date.now()}` });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    delete process.env.USER_PROFILE_API_ENABLED;
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
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'lives_at', confidence: 0.9 }],
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

  it("the name follows a `name` fact — the user's own words or an onboarding write — and the profile reports it", async () => {
    const row = await userEntity();
    expect(row!.canonicalName).toBe('Sasha');
    // The user says who they are; the extractor files it as `name` on their entity.
    f.extractor.setScript({
      entities: [{ name: 'Alexander Petrov', type: 'customer', known: String(row!.id) }],
      facts: [{ entityIndex: 0, predicate: 'name', object: 'Alexander Petrov', confidence: 0.95 }],
      edges: [],
    });
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text: 'My full name is Alexander Petrov.',
        userId: USER,
        contextRef: { vertical: 'chat', conversationId: 'c-user', messageId: 'm4' },
      });
    expect(res.status).toBe(201);
    const renamed = await userEntity();
    expect(renamed!.canonicalName).toBe('Alexander Petrov');
    expect(renamed!.aliases).toEqual(expect.arrayContaining(['Sasha', 'Alexander Petrov']));
    const profile = await f.http.get(`/v1/users/${USER}/profile`).set(auth());
    expect(profile.status).toBe(200);
    expect(profile.body.identity).toEqual({ entityId: String(row!.id), name: 'Alexander Petrov' });
    expect(profile.body.profileText.split('\n')[0]).toBe('- [identity] name: Alexander Petrov');
    // A user the memory has not heard from has no identity yet.
    const none = await f.http.get('/v1/users/user_77/profile').set(auth());
    expect(none.body.identity).toEqual({ entityId: null, name: null });
    expect(none.body.profileText).toContain('name: not learned yet');
  });

  it('synthesize heads the asker\'s own lines "you" and names them, for that user and nobody else', async () => {
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
    expect(generator).toContain(
      'Query: Where do I live?\nAsker: the evidence lines headed "you" are about the person asking (Alexander Petrov)',
    );
    expect(generator).toMatch(/\[f\d+\] you — lives_in: Berlin/);
    expect(generator).not.toContain('Alexander Petrov (customer) — lives_in');
    const auditor = own.calls.find((c) => c.user.includes('Answer:'))?.user ?? '';
    expect(auditor).toContain(
      'Asker: "you" in the evidence is the person asking (Alexander Petrov)',
    );
    expect(auditor).toMatch(/\[f\d+\] you — lives_in: Berlin/);

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
