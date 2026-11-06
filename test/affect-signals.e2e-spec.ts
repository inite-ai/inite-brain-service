/**
 * #909 step 5 on a real SurrealDB: relationship_context serves the
 * person's inferred affect as signals to a caller holding brain:read_pii,
 * and to nobody else; `state` still answers only from what they said.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EntitiesService } from '../src/entities/entities.service';
import type { BrainScope } from '../src/auth/api-key.types';

const U = 'affect_signals_user';

describe('affect signals in relationship_context', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: `co_affsig_${Date.now()}` });
    await f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [ep] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE episode CONTENT {
           kind: 'turn', conversationId: 'c1', messageId: 'm1', speaker: $s,
           text: 'I dread the weigh-in', occurredAt: time::now(), userId: $u,
           scope: [$tag], source: { vertical: 'chat' } } RETURN id`,
        { s: `user:${U}`, u: U, tag: `user:${U}` },
      );
      await db.query(
        `CREATE affect_observation CONTENT {
           userId: $u, episodeId: $e, conversationId: 'c1', scope: [$tag],
           observedAt: time::now() - 1d, valence: -0.6, label: 'fear', target: 'the weigh-in',
           quote: 'dread the weigh-in', spanStart: 2, spanEnd: 20, confidence: 0.8,
           readerVersion: 'affect-reader-v1' }`,
        { u: U, e: ep![0]!.id, tag: `user:${U}` },
      );
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ctx = (scopes: BrainScope[]) =>
    f.app
      .get(EntitiesService)
      .getRelationshipContext({ companyId: f.companyId, userId: U, scopes });

  it('a brain:read_pii caller sees the signal, with the words; state stays unknown', async () => {
    const c = await ctx(['brain:read', 'brain:read_pii']);
    expect(c.affectSignals?.kind).toBe('inferred');
    expect(c.affectSignals?.recent[0]).toMatchObject({
      label: 'fear',
      about: 'the weigh-in',
      quote: 'dread the weigh-in',
    });
    expect(c.affectSignals?.baseline).toMatchObject({ meanValence: -0.6, n: 1 });
    expect(c.state.known).toBe(false);
  });

  it('a brain:read caller gets no affectSignals at all', async () => {
    expect((await ctx(['brain:read'])).affectSignals).toBeUndefined();
  });
});
