/**
 * The two-line write, end to end.
 *
 * `test/ingest-mention-defaults.unit-spec.ts` proves the ValidationPipe
 * fills the defaults. This proves nothing downstream trips over them:
 * the episode, the extracted facts and their source key all have to
 * come out right from a body that carried only `text` and `userId`.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('POST /v1/ingest/mention with text alone', () => {
  let f: AppFixture;
  let surreal: SurrealService;

  beforeAll(async () => {
    f = await createApp({ companyId: `co_minmention_${Date.now()}` });
    surreal = f.app.get(SurrealService);
    f.extractor.setScript({
      entities: [{ name: 'Maria', type: 'customer' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'lives_in',
          object: 'Berlin',
          confidence: 0.9,
        },
      ],
      edges: [],
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('accepts the body the quickstart shows and writes a fact', async () => {
    const before = Date.now();
    const res = await f.http
      .post('/v1/ingest/mention')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({
        text: 'Maria moved to Berlin in June and prefers morning appointments.',
        userId: 'user_42',
      });

    expect(res.status).toBe(201);
    expect(res.body.skipped).toBe(false);
    expect(res.body.extractedFactIds?.length).toBeGreaterThan(0);

    const factId = String(res.body.extractedFactIds[0]);
    const row = await surreal.withCompany(f.companyId, async (db) => {
      const tail = factId.includes(':') ? factId.split(':')[1] : factId;
      const [rows] = await db.query<Record<string, unknown>[][]>(
        `SELECT source, userId, validFrom FROM type::record('knowledge_fact', $t)`,
        { t: tail },
      );
      return rows?.[0] ?? null;
    });

    expect(row).not.toBeNull();
    // The default vertical rides all the way into the stored source, so
    // source trust keys on `chat:<model>` rather than on nothing.
    expect((row?.source as { vertical?: string })?.vertical).toBe('chat');
    // The per-user fence still applies — the one field the caller did send.
    expect(row?.userId).toBe('user_42');
    // emittedAt defaulted to request time, and validFrom follows it.
    const validFrom = Date.parse(String(row?.validFrom));
    expect(validFrom).toBeGreaterThanOrEqual(before - 60_000);
    expect(validFrom).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('still fences the read: the fact is invisible without the same userId', async () => {
    const mine = await f.http
      .post('/v1/search')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ query: 'Maria Berlin', userId: 'user_42', limit: 5 });
    expect(mine.status).toBe(201);
    const mineFacts = (mine.body.results ?? []).flatMap(
      (hit: { facts?: unknown[] }) => hit.facts ?? [],
    );
    expect(mineFacts.length).toBeGreaterThan(0);

    const global = await f.http
      .post('/v1/search')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ query: 'Maria Berlin', limit: 5 });
    expect(global.status).toBe(201);
    const globalFacts = (global.body.results ?? []).flatMap(
      (hit: { facts?: unknown[] }) => hit.facts ?? [],
    );
    expect(globalFacts).toHaveLength(0);
  });
});
