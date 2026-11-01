/**
 * Idempotency-Key end to end (0179, draft-ietf-httpapi-idempotency-key-header):
 * a retried write replays the first answer and writes nothing; the same
 * key on a different request is 422; a 4xx is replayed too; user forget
 * erases the user's stored answers; the sweep deletes expired keys.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { IdempotencyStoreService } from '../src/idempotency/idempotency-store.service';

describe('Idempotency-Key on writes (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_idempotency_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> =>
    f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  const fact = (object: string, userId?: string) => ({
    entityRef: { vertical: 'rent', id: 'idem_subject' },
    predicate: 'tier',
    object,
    validFrom: '2026-01-01',
    confidence: 0.9,
    source: { vertical: 'rent', recorder: 'idem_bot' },
    ...(userId ? { userId } : {}),
  });
  const post = (key: string, body: unknown) =>
    f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .set('Idempotency-Key', key)
      .send(body as object);

  it('a retry replays the first answer and writes nothing', async () => {
    const first = await post('k-1', fact('gold'));
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await post('k-1', fact('gold'));
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    const written = await rows(`SELECT id FROM knowledge_fact WHERE object = 'gold'`);
    expect(written).toHaveLength(1);
  });

  it('the same key on a different request is 422, and nothing is written', async () => {
    const other = await post('k-1', fact('platinum'));
    expect(other.status).toBe(422);
    expect(await rows(`SELECT id FROM knowledge_fact WHERE object = 'platinum'`)).toHaveLength(0);
  });

  it('a 4xx is stored and replayed; a malformed key is refused', async () => {
    const bad = await post('k-2', { predicate: 'tier' });
    expect(bad.status).toBe(400);
    const again = await post('k-2', { predicate: 'tier' });
    expect(again.status).toBe(400);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.message).toEqual(bad.body.message);
    const malformed = await post('has space', fact('silver'));
    expect(malformed.status).toBe(400);
  });

  it('without the header nothing changes', async () => {
    const a = await f.http.post('/v1/ingest/fact').set(auth()).send(fact('bronze'));
    const b = await f.http.post('/v1/ingest/fact').set(auth()).send(fact('bronze'));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
  });

  it("user forget erases the user's stored answers; the sweep deletes expired keys", async () => {
    expect((await post('k-user', fact('copper', 'u_idem'))).status).toBe(201);
    expect(await rows(`SELECT id FROM idempotency_key WHERE userId = 'u_idem'`)).toHaveLength(1);
    const forget = await f.http.post('/v1/users/u_idem/forget').set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(await rows(`SELECT id FROM idempotency_key WHERE userId = 'u_idem'`)).toHaveLength(0);

    await rows(`UPDATE idempotency_key SET expiresAt = time::now() - 1h WHERE key = 'k-1'`);
    const swept = await f.app.get(IdempotencyStoreService).sweep([f.companyId]);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await rows(`SELECT id FROM idempotency_key WHERE key = 'k-1'`)).toHaveLength(0);
  });
});
