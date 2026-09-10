/**
 * Self-serve keys, end to end: mint one over HTTP, authenticate a real
 * request with it, then revoke it and watch that request stop working.
 *
 * The unit specs cover the rules; this one covers the claim the feature
 * actually makes — that a key brain issued is a credential brain accepts.
 * It exercises the store against a real SurrealDB, including migration
 * 0141 applying to the system database.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('POST /v1/keys', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_keys_e2e',
      scopes: ['brain:read', 'brain:write'],
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  it('issues a key that authenticates, and stops working once revoked', async () => {
    const issued = await f.http
      .post('/v1/keys')
      .set(auth())
      .send({ name: 'e2e laptop', scopes: ['brain:read'] });
    expect(issued.status).toBe(201);
    expect(issued.body.key).toMatch(/^brain_[0-9a-f]{48}$/);
    expect(issued.body.companyId).toBe('co_keys_e2e');
    expect(issued.body.mcpUrl).toMatch(/\/mcp\/co_keys_e2e$/);

    const minted = issued.body.key as string;
    const keyId = issued.body.keyRecord.id as string;

    // The whole point: the new key is a working credential.
    const search = await f.http
      .post('/v1/search')
      .set({ Authorization: `Bearer ${minted}` })
      .send({ query: 'anything', limit: 1 });
    expect(search.status).toBe(201); // Nest's default for POST
    expect(Array.isArray(search.body.results ?? search.body.entities ?? [])).toBe(true);

    // It carries only the scope it was granted — read, not write.
    const write = await f.http
      .post('/v1/ingest/fact')
      .set({ Authorization: `Bearer ${minted}` })
      .send({
        entityRef: { vertical: 'rent', id: 'cust_1' },
        predicate: 'likes',
        object: 'tea',
        source: { vertical: 'rent', messageId: 'm1' },
      });
    expect(write.status).toBe(403);

    const listed = await f.http.get('/v1/keys').set(auth());
    expect(listed.status).toBe(200);
    expect(listed.body.issuingEnabled).toBe(true);
    expect(listed.body.keys.map((k: { id: string }) => k.id)).toContain(keyId);
    // Listings never carry the secret or its hash.
    expect(JSON.stringify(listed.body)).not.toContain(minted);
    expect(JSON.stringify(listed.body)).not.toContain('sha256:');

    const revoked = await f.http.post(`/v1/keys/${keyId}/revoke`).set(auth());
    expect(revoked.status).toBe(201);
    expect(revoked.body.revoked).toBe(true);

    const afterRevoke = await f.http
      .post('/v1/search')
      .set({ Authorization: `Bearer ${minted}` })
      .send({ query: 'anything', limit: 1 });
    expect(afterRevoke.status).toBe(401);
  });

  it('refuses to mint a key wider than the credential asking for it', async () => {
    const res = await f.http
      .post('/v1/keys')
      .set(auth())
      .send({ name: 'escalation', scopes: ['brain:admin'] });
    expect(res.status).toBe(403);
  });

  it('rejects a scope that is not delegable at all', async () => {
    const res = await f.http
      .post('/v1/keys')
      .set(auth())
      .send({ name: 'operator', scopes: ['brain:platform_admin'] });
    // Blocked by the DTO before any narrowing runs.
    expect(res.status).toBe(400);
  });

  it('needs a credential of its own', async () => {
    const res = await f.http.post('/v1/keys').send({ name: 'anon', scopes: ['brain:read'] });
    expect(res.status).toBe(401);
  });
});
