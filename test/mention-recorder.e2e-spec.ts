/**
 * source.recorder must be populated for mention-extracted facts so
 * fn::source_key_of yields a discriminating `vertical:recorder` key (per
 * model) instead of collapsing every extracted fact to `vertical:_`. The
 * caller may override via contextRef.recorder; otherwise it defaults to the
 * extraction model id (the StubExtractor reports 'stub-extractor').
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('mention ingest populates source.recorder', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const recordersFor = async (objectText: string): Promise<string[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ recorder: string | null }>]>(
        `SELECT source.recorder AS recorder FROM knowledge_fact
           WHERE object = $obj`,
        { obj: objectText },
      );
      return ((rows as Array<{ recorder: string | null }>) ?? []).map(
        (r) => r.recorder ?? '_',
      );
    });
  };

  it('defaults recorder to the extraction model id', async () => {
    const text = 'Acme upgraded to enterprise tier';
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        contextRef: { vertical: 'rent', conversationId: 'conv_default' },
        emittedAt: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
    const recorders = await recordersFor(text);
    expect(recorders.length).toBeGreaterThanOrEqual(1);
    expect(recorders.every((r) => r === 'stub-extractor')).toBe(true);
  });

  it('honours a caller-provided contextRef.recorder', async () => {
    const text = 'Globex switched billing plan';
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        contextRef: {
          vertical: 'rent',
          conversationId: 'conv_override',
          recorder: 'crm.webhook',
        },
        emittedAt: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
    const recorders = await recordersFor(text);
    expect(recorders.length).toBeGreaterThanOrEqual(1);
    expect(recorders.every((r) => r === 'crm.webhook')).toBe(true);
  });
});
