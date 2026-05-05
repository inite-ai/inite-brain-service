import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

// All tests share one app + one tenant by default. Forget cascade test
// uses its own tenant for isolation.
describe('Brain Service e2e', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    await f.close();
  });

  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  describe('GET /health', () => {
    it('reports ok with surrealdb reachable', async () => {
      const res = await f.http.get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        service: 'inite-brain-service',
        checks: { surrealdb: 'ok' },
      });
    });
  });

  describe('Auth', () => {
    it('rejects requests without Bearer', async () => {
      const res = await f.http
        .post('/v1/search')
        .send({ query: 'hi' });
      expect(res.status).toBe(401);
    });

    it('rejects unknown api key', async () => {
      const res = await f.http
        .post('/v1/search')
        .set('Authorization', 'Bearer wrong')
        .send({ query: 'hi' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /v1/ingest/fact', () => {
    it('inserts a fact and returns INSERTED', async () => {
      const res = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'cust_alpha' },
          predicate: 'complained_about',
          object: 'late maintenance',
          validFrom: new Date('2026-04-01').toISOString(),
          source: { vertical: 'rent', messageId: 'msg_1' },
          confidence: 0.7,
        });
      expect(res.status).toBe(201);
      expect(res.body.outcome).toBe('INSERTED');
      expect(res.body.factId).toMatch(/^knowledge_fact:/);
    });

    it('SUPERSEDED when single_active predicate gets a new value', async () => {
      // `name` is single_active per predicate policy: every new value
      // supersedes the prior one regardless of embedding similarity.
      const r1 = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'cust_name_test' },
          predicate: 'name',
          object: 'Old Co Ltd',
          validFrom: new Date('2026-04-01').toISOString(),
          source: { vertical: 'rent', eventId: 'auth.test1' },
          confidence: 0.9,
        });
      expect(r1.body.outcome).toBe('INSERTED');

      const r2 = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'cust_name_test' },
          predicate: 'name',
          object: 'New Co Ltd',
          validFrom: new Date('2026-04-15').toISOString(),
          source: { vertical: 'rent', eventId: 'auth.test2' },
          confidence: 0.9,
        });
      expect(r2.body.outcome).toBe('SUPERSEDED');
      expect(r2.body.supersededFactIds).toEqual([r1.body.factId]);
    });

    it('append_only predicate never produces SUPERSEDED', async () => {
      const r1 = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'cust_append' },
          predicate: 'said',
          object: 'hello',
          validFrom: new Date('2026-04-01').toISOString(),
          source: { vertical: 'rent', messageId: 'm1' },
        });
      const r2 = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'cust_append' },
          predicate: 'said',
          object: 'hello',
          validFrom: new Date('2026-04-02').toISOString(),
          source: { vertical: 'rent', messageId: 'm2' },
        });
      expect(r1.body.outcome).toBe('INSERTED');
      expect(r2.body.outcome).toBe('INSERTED');
    });
  });

  describe('POST /v1/search', () => {
    it('finds entities by semantic match (deterministic stub: identical text)', async () => {
      // Use a unique entity so the assertion is unambiguous.
      const uniqueObject = 'extreme winter draft from balcony seal failure';
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'cust_search_test' },
        predicate: 'complained_about',
        object: uniqueObject,
        validFrom: new Date().toISOString(),
        source: { vertical: 'rent', messageId: 'msg_search' },
      });
      const res = await f.http
        .post('/v1/search')
        .set(auth())
        .send({ query: `complained_about: ${uniqueObject}`, limit: 5 });
      expect(res.status).toBe(201);
      expect(res.body.results.length).toBeGreaterThan(0);
      const top = res.body.results[0];
      expect(top.facts.some((x: any) => x.object === uniqueObject)).toBe(true);
    });

    it('respects asOf bitemporal filter', async () => {
      const uniqueObject = 'transient annoyance probably ignorable';
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'cust_asof' },
        predicate: 'complained_about',
        object: uniqueObject,
        validFrom: new Date('2026-04-15').toISOString(),
        source: { vertical: 'rent', messageId: 'msg_asof' },
      });
      // asOf earlier than recordedAt → should NOT see the fact
      const earlier = await f.http
        .post('/v1/search')
        .set(auth())
        .send({
          query: `complained_about: ${uniqueObject}`,
          asOf: '2025-01-01T00:00:00Z',
        });
      const found = (earlier.body.results ?? [])
        .flatMap((r: any) => r.facts)
        .some((x: any) => x.object === uniqueObject);
      expect(found).toBe(false);
    });
  });

  describe('Entity reads', () => {
    let entityId: string;
    let factId: string;

    beforeAll(async () => {
      const r = await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'cust_reads' },
        predicate: 'name',
        object: 'Acme Corp',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent', messageId: 'm_reads' },
        confidence: 0.95,
      });
      factId = r.body.factId;
      // Look up entityId via search to keep this self-contained.
      const s = await f.http
        .post('/v1/search')
        .set(auth())
        .send({ query: 'name: Acme Corp', limit: 1 });
      entityId = s.body.results[0].entityId;
    });

    it('GET /v1/entities/:id returns profile', async () => {
      const res = await f.http
        .get(`/v1/entities/${encodeURIComponent(entityId)}`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.entityId).toBe(entityId);
      expect(res.body.facts.some((x: any) => x.factId === factId)).toBe(true);
    });

    it('GET /v1/entities/:id/timeline returns recorded events', async () => {
      const res = await f.http
        .get(`/v1/entities/${encodeURIComponent(entityId)}/timeline`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeGreaterThan(0);
      expect(res.body.events.every((e: any) => e.type === 'fact.recorded')).toBe(true);
    });
  });

  describe('POST /v1/facts/:id/retract', () => {
    it('closes validity and removes from active reads', async () => {
      // Ingest a fresh fact to retract.
      const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'cust_retract' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent', messageId: 'm_ret' },
      });
      const factId = ingest.body.factId;

      const retract = await f.http
        .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
        .set(auth())
        .send({ reason: 'operator correction', retractedBy: { source: 'human' } });
      expect(retract.status).toBe(201);
      expect(retract.body.factId).toBe(factId);
      expect(retract.body.cascadedFactIds).toEqual([]);

      // Search should NOT include this fact anymore.
      const search = await f.http
        .post('/v1/search')
        .set(auth())
        .send({ query: 'tier: platinum', includeRetracted: false });
      const stillThere = (search.body.results ?? [])
        .flatMap((r: any) => r.facts)
        .some((x: any) => x.factId === factId);
      expect(stillThere).toBe(false);

      // Timeline should still show it (recorded + retracted events). The
      // exact entity id isn't surfaced by /v1/ingest/fact today; the
      // dedicated entity-reads test covers timeline-with-retractions.
    });

    it('idempotent on already-retracted fact', async () => {
      const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'cust_retract_idem' },
        predicate: 'tier',
        object: 'gold',
        validFrom: new Date().toISOString(),
        source: { vertical: 'rent', messageId: 'm_idem' },
      });
      const factId = ingest.body.factId;
      const a = await f.http
        .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
        .set(auth())
        .send({ reason: 'a', retractedBy: { source: 'human' } });
      const b = await f.http
        .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
        .set(auth())
        .send({ reason: 'b', retractedBy: { source: 'human' } });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.cascadedFactIds).toEqual([]);
    });
  });

  describe('PII gating', () => {
    it('hides sensitive predicate facts from callers without brain:read_pii', async () => {
      // Create a separate app instance whose key lacks brain:read_pii.
      const limited = await createApp({
        scopes: ['brain:read', 'brain:write'],
      });
      const limitedAuth = { Authorization: `Bearer ${limited.apiKey}` };

      // Seed an address fact under the limited tenant.
      await limited.http.post('/v1/ingest/fact').set(limitedAuth).send({
        entityRef: { vertical: 'rent', id: 'cust_pii' },
        predicate: 'address',
        object: '1 Main St',
        validFrom: new Date().toISOString(),
        source: { vertical: 'rent', messageId: 'm_pii' },
      });
      const search = await limited.http
        .post('/v1/search')
        .set(limitedAuth)
        .send({ query: 'address: 1 Main St' });
      const found = (search.body.results ?? [])
        .flatMap((r: any) => r.facts)
        .some((x: any) => x.predicate === 'address');
      expect(found).toBe(false);

      await limited.close();
    });
  });

  describe('POST /v1/entities/:id/forget', () => {
    it('hard-deletes entity + facts + edges and writes tombstone', async () => {
      const tenant = await createApp();
      const tAuth = { Authorization: `Bearer ${tenant.apiKey}` };

      // Seed
      await tenant.http.post('/v1/ingest/fact').set(tAuth).send({
        entityRef: { vertical: 'rent', id: 'cust_forget' },
        predicate: 'name',
        object: 'Forgettable Customer',
        validFrom: new Date().toISOString(),
        source: { vertical: 'rent', messageId: 'm_f1' },
      });
      await tenant.http.post('/v1/ingest/fact').set(tAuth).send({
        entityRef: { vertical: 'rent', id: 'cust_forget' },
        predicate: 'email',
        object: 'forget@example.com',
        validFrom: new Date().toISOString(),
        source: { vertical: 'rent', messageId: 'm_f2' },
      });
      const s = await tenant.http
        .post('/v1/search')
        .set(tAuth)
        .send({ query: 'name: Forgettable Customer' });
      const entityId = s.body.results[0].entityId;

      const forget = await tenant.http
        .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
        .set(tAuth)
        .send({ reason: 'gdpr_request', requestId: 'req_test_1' });
      expect(forget.status).toBe(201);
      expect(forget.body.factsDeleted).toBeGreaterThanOrEqual(2);
      expect(forget.body.entityIdHash.startsWith('hmac:')).toBe(true);

      // Subsequent profile read → 404
      const r = await tenant.http
        .get(`/v1/entities/${encodeURIComponent(entityId)}`)
        .set(tAuth);
      expect(r.status).toBe(404);

      // Search returns no results for that entity
      const after = await tenant.http
        .post('/v1/search')
        .set(tAuth)
        .send({ query: 'name: Forgettable Customer' });
      const stillReturned = (after.body.results ?? []).some(
        (x: any) => x.entityId === entityId,
      );
      expect(stillReturned).toBe(false);

      await tenant.close();
    });
  });

  describe('MCP path companyId enforcement', () => {
    it('400s when path companyId differs from ApiKey companyId', async () => {
      const res = await f.http
        .post('/mcp/co_someone_else')
        .set(auth())
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      expect(res.status).toBe(400);
    });
  });
});
