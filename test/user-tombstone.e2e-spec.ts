/**
 * The forget tombstone, end to end.
 *
 * In production a mention is extracted in the background, and a client
 * that times out leaves the server's work running. Work accepted BEFORE
 * POST /v1/users/:userId/forget and finishing AFTER it used to write the
 * person straight back. These cases run that work with its real
 * acceptance time (runAccepted, what the request middleware and the job
 * dispatcher open) and check the database.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { IngestService } from '../src/ingest/ingest.service';
import { runAccepted } from '../src/common/user-tombstone';
import type { ExtractionResult } from '../src/ai/extractor.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import type { IngestFactDto } from '../src/ingest/dto/ingest-fact.dto';

jest.setTimeout(180_000);

const MOVED: ExtractionResult = {
  entities: [{ name: 'Maria Lopez', type: 'person' }],
  facts: [{ entityIndex: 0, predicate: 'city', object: 'Lisbon', confidence: 0.9 }],
  edges: [],
};

describe('forget tombstone', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_user_tombstone_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  afterEach(() => f.extractor.setScript(null));

  const count = async (table: string, userId: string): Promise<number> =>
    f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM type::table($t) WHERE userId = $u`,
        { t: table, u: userId },
      );
      return ((rows as unknown[]) ?? []).length;
    });

  const mention = (userId: string): IngestMentionDto =>
    ({
      text: 'Maria Lopez moved to Lisbon last month.',
      contextRef: { vertical: 'chat' },
      emittedAt: new Date().toISOString(),
      userId,
    }) as unknown as IngestMentionDto;

  it('an extraction accepted before the forget and finishing after it writes nothing', async () => {
    const accepted = new Date(Date.now() - 5_000);
    const forget = await f.http.post('/v1/users/u_late/forget').set(auth()).send({});
    expect(forget.status).toBeLessThan(300);

    f.extractor.setScript(MOVED);
    const out = await runAccepted(accepted, () =>
      f.app.get(IngestService).ingestMention(f.companyId, mention('u_late')),
    );
    expect(out.extractedFactIds ?? []).toHaveLength(0);
    expect(await count('knowledge_fact', 'u_late')).toBe(0);
    expect(await count('episode', 'u_late')).toBe(0);
    expect(await count('source_document', 'u_late')).toBe(0);
  });

  it('a typed fact accepted before the forget is rejected, entity included', async () => {
    const accepted = new Date(Date.now() - 5_000);
    await f.http.post('/v1/users/u_fact/forget').set(auth()).send({});
    const res = await runAccepted(accepted, () =>
      f.app.get(IngestService).ingestFact(f.companyId, {
        entityRef: { vertical: 'user', id: 'u_fact' },
        predicate: 'city',
        object: 'Lisbon',
        validFrom: new Date().toISOString(),
        source: { vertical: 'chat' },
        userId: 'u_fact',
      } as unknown as IngestFactDto),
    );
    expect(res).toMatchObject({ factId: null, outcome: 'REJECTED', reason: 'user_forgotten' });
    expect(await count('knowledge_fact', 'u_fact')).toBe(0);
    expect(await count('knowledge_entity', 'u_fact')).toBe(0);
  });

  it('a person who comes back after the forget is written again', async () => {
    await f.http.post('/v1/users/u_back/forget').set(auth()).send({});
    // A request that arrives after the forget is accepted after it.
    await new Promise((r) => setTimeout(r, 10));
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'user', id: 'u_back' },
        predicate: 'city',
        object: 'Porto',
        validFrom: new Date().toISOString(),
        source: { vertical: 'chat' },
        userId: 'u_back',
      });
    expect(res.status).toBe(201);
    expect(res.body.factId).toBeTruthy();
    expect(await count('knowledge_fact', 'u_back')).toBe(1);
  });
});
