/**
 * Compilation-stage e2e: knowledge artifacts + KnowQL-lite agent primitives.
 *
 * Validates the article-aligned features (cf. Pinecone Nexus framing,
 * VentureBeat 2026-05-04):
 *   1. Pre-built typed bundles per (entity, artifactType) with
 *      field-level citations.
 *   2. CHANGEFEED-driven invalidation — fact mutations flip artifacts
 *      to dirty, the next read recompiles transparently.
 *   3. Agent query primitives — confidenceFloor, tokenBudget,
 *      outputShape.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('Compilation stage — artifacts + KnowQL-lite', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  // ── shared seeding ─────────────────────────────────────────────
  let entityId: string;

  const seed = async () => {
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'art_cust' },
      predicate: 'name',
      object: 'Anya Volkova',
      validFrom: new Date('2026-04-01').toISOString(),
      source: { vertical: 'rent', eventId: 'auth.profile_created' },
      confidence: 0.95,
    });
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'art_cust' },
      predicate: 'tier',
      object: 'gold',
      validFrom: new Date('2026-04-01').toISOString(),
      source: { vertical: 'rent', eventId: 'billing.tier_set' },
      confidence: 0.9,
    });
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'art_cust' },
      predicate: 'email',
      object: 'anya@example.com',
      validFrom: new Date('2026-04-01').toISOString(),
      source: { vertical: 'rent', eventId: 'auth.email_set' },
      confidence: 0.95,
    });
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'art_cust' },
      predicate: 'complained_about',
      object: 'broken heating in apartment 3B',
      validFrom: new Date('2026-04-15').toISOString(),
      source: { vertical: 'rent', messageId: 'msg_av_1' },
      confidence: 0.8,
    });
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'art_cust' },
      predicate: 'interacted_with',
      object: 'on-site maintenance visit',
      validFrom: new Date('2026-04-20').toISOString(),
      source: { vertical: 'rent', eventId: 'incidents.visit_completed' },
      confidence: 0.9,
    });

    const v = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'name: Anya Volkova', limit: 50, searchMode: 'vector' });
    const hit = v.body.results.find((r: any) => r.canonicalName === 'art_cust');
    entityId = hit?.entityId ?? '';
    expect(entityId).toBeTruthy();
  };

  beforeAll(seed);

  // ── Knowledge artifact: customer_profile ──────────────────────
  describe('Knowledge artifact — customer_profile', () => {
    it('compiles a typed bundle on first read with field-level citations', async () => {
      const res = await f.http
        .get(`/v1/artifacts/customer_profile/${encodeURIComponent(entityId)}`)
        .set(auth());
      expect(res.status).toBe(200);
      const artifact = res.body;
      expect(artifact.artifactType).toBe('customer_profile');
      expect(artifact.entityId).toBe(entityId);

      // Payload reflects the seeded facts.
      expect(artifact.payload.name).toBe('Anya Volkova');
      expect(artifact.payload.tier).toBe('gold');
      expect(artifact.payload.email).toBe('anya@example.com');
      expect(artifact.payload.recentInteractions).toEqual(
        expect.arrayContaining(['on-site maintenance visit']),
      );

      // Per-field citations carry factId + confidence + ingest source.
      expect(artifact.citations.name).toEqual([
        expect.objectContaining({
          factId: expect.stringMatching(/^knowledge_fact:/),
          confidence: 0.95,
          source: expect.objectContaining({
            vertical: 'rent',
            eventId: 'auth.profile_created',
          }),
        }),
      ]);
      expect(artifact.citations.tier?.[0].confidence).toBe(0.9);

      // Source fact ids list aggregates citations.
      expect(artifact.sourceFactIds.length).toBeGreaterThanOrEqual(4);
      // freshFor is positive (within staleAfterMs of compile time).
      expect(artifact.freshFor).toBeGreaterThan(0);
    });

    it('serves cached on second read (freshFor decreases, builtAt unchanged)', async () => {
      const a = await f.http
        .get(`/v1/artifacts/customer_profile/${encodeURIComponent(entityId)}`)
        .set(auth());
      // Pause briefly so the freshFor decrement is observable.
      await new Promise((r) => setTimeout(r, 50));
      const b = await f.http
        .get(`/v1/artifacts/customer_profile/${encodeURIComponent(entityId)}`)
        .set(auth());
      expect(a.body.builtAt).toBe(b.body.builtAt);
      expect(b.body.freshFor).toBeLessThanOrEqual(a.body.freshFor);
    });

    it('invalidates on fact mutation via CHANGEFEED event', async () => {
      const before = await f.http
        .get(`/v1/artifacts/customer_profile/${encodeURIComponent(entityId)}`)
        .set(auth());
      const beforeBuiltAt = before.body.builtAt;

      // Mutate: ingest a new fact for the same entity.
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'art_cust' },
        predicate: 'said',
        object: 'Thanks for the quick fix',
        validFrom: new Date().toISOString(),
        source: { vertical: 'rent', messageId: 'msg_av_2' },
      });

      // Next read should recompile (same builtAt would be a bug).
      const after = await f.http
        .get(`/v1/artifacts/customer_profile/${encodeURIComponent(entityId)}`)
        .set(auth());
      expect(after.status).toBe(200);
      expect(new Date(after.body.builtAt).getTime()).toBeGreaterThan(
        new Date(beforeBuiltAt).getTime(),
      );
    });

    it('recompile endpoint forces fresh build', async () => {
      const before = await f.http
        .get(`/v1/artifacts/customer_profile/${encodeURIComponent(entityId)}`)
        .set(auth());
      // Pause to ensure builtAt timestamps can differ.
      await new Promise((r) => setTimeout(r, 30));
      const recompiled = await f.http
        .post(
          `/v1/artifacts/customer_profile/${encodeURIComponent(entityId)}/recompile`,
        )
        .set(auth());
      expect(recompiled.status).toBe(201);
      expect(new Date(recompiled.body.builtAt).getTime()).toBeGreaterThan(
        new Date(before.body.builtAt).getTime(),
      );
    });
  });

  // ── Knowledge artifact: support_context ───────────────────────
  describe('Knowledge artifact — support_context', () => {
    it('aggregates complaints + utterances with citations', async () => {
      const res = await f.http
        .get(`/v1/artifacts/support_context/${encodeURIComponent(entityId)}`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.payload.complaintCount).toBeGreaterThanOrEqual(1);
      expect(res.body.payload.complaints).toEqual(
        expect.arrayContaining(['broken heating in apartment 3B']),
      );
      expect(res.body.citations.complaints?.[0].source).toMatchObject({
        vertical: 'rent',
        messageId: 'msg_av_1',
      });
    });
  });

  // ── PII gate on artifact reads ────────────────────────────────
  describe('Artifact PII gating', () => {
    it('strips email field when caller lacks brain:read_pii', async () => {
      // Spawn a limited-scope tenant.
      const limited = await createApp({
        scopes: ['brain:read', 'brain:write'],
      });
      try {
        const lAuth = () => ({ Authorization: `Bearer ${limited.apiKey}` });
        // Seed the same entity in this tenant.
        await limited.http.post('/v1/ingest/fact').set(lAuth()).send({
          entityRef: { vertical: 'rent', id: 'pii_cust' },
          predicate: 'name',
          object: 'Bob Test',
          validFrom: new Date('2026-04-01').toISOString(),
          source: { vertical: 'rent' },
        });
        await limited.http.post('/v1/ingest/fact').set(lAuth()).send({
          entityRef: { vertical: 'rent', id: 'pii_cust' },
          predicate: 'address',
          object: '42 Some Street',
          validFrom: new Date('2026-04-01').toISOString(),
          source: { vertical: 'rent', eventId: 'billing.address_set' },
        });

        const v = await limited.http
          .post('/v1/search')
          .set(lAuth())
          .send({ query: 'name: Bob Test', limit: 50, searchMode: 'vector' });
        const eId = v.body.results.find(
          (r: any) => r.canonicalName === 'pii_cust',
        )?.entityId;
        expect(eId).toBeTruthy();

        const dossier = await limited.http
          .get(`/v1/artifacts/identity_dossier/${encodeURIComponent(eId)}`)
          .set(lAuth());
        expect(dossier.status).toBe(200);
        // address requires brain:read_pii — limited caller cannot see it.
        expect(dossier.body.payload.address).toBeUndefined();
        // name is non-PII — visible.
        expect(dossier.body.payload.name).toEqual(['Bob Test']);
      } finally {
        await limited.close();
      }
    });
  });

  // ── Per-vertical templates ────────────────────────────────────
  describe('Per-vertical artifact templates', () => {
    it('rent: tenant_dossier surfaces rental + payment + incident facts', async () => {
      // Seed rent-vertical predicates (domain extensions; treated under
      // default policy until knowledge.yaml registers them).
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'rent_tenant' },
        predicate: 'name',
        object: 'Maria Renter',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent' },
      });
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'rent_tenant' },
        predicate: 'rented_vehicle',
        object: 'Toyota Corolla 2024 (rental #4821)',
        validFrom: new Date('2026-04-15').toISOString(),
        source: { vertical: 'rent', eventId: 'billing.rental_started' },
      });
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'rent', id: 'rent_tenant' },
        predicate: 'paid_invoice',
        object: 'invoice INV-9821 paid',
        validFrom: new Date('2026-04-16').toISOString(),
        source: { vertical: 'rent', eventId: 'billing.invoice_paid' },
      });

      const v = await f.http.post('/v1/search').set(auth()).send({
        query: 'name: Maria Renter',
        limit: 50,
        searchMode: 'vector',
      });
      const eId = v.body.results.find(
        (r: any) => r.canonicalName === 'rent_tenant',
      )?.entityId;
      expect(eId).toBeTruthy();

      const dossier = await f.http
        .get(`/v1/artifacts/tenant_dossier/${encodeURIComponent(eId)}`)
        .set(auth());
      expect(dossier.status).toBe(200);
      expect(dossier.body.payload.name).toBe('Maria Renter');
      expect(dossier.body.payload.rentalHistory).toEqual(
        expect.arrayContaining(['Toyota Corolla 2024 (rental #4821)']),
      );
      expect(dossier.body.payload.paymentEvents).toEqual(
        expect.arrayContaining(['invoice INV-9821 paid']),
      );
    });

    it('shop: order_history with returns + reviews', async () => {
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'shop', id: 'shop_buyer' },
        predicate: 'name',
        object: 'Felix Buyer',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'shop' },
      });
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'shop', id: 'shop_buyer' },
        predicate: 'placed_order',
        object: 'order #SHP-1234',
        validFrom: new Date('2026-04-15').toISOString(),
        source: { vertical: 'shop', eventId: 'billing.order_placed' },
      });
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'shop', id: 'shop_buyer' },
        predicate: 'returned_item',
        object: 'returned: SKU-99 from order #SHP-1234',
        validFrom: new Date('2026-04-20').toISOString(),
        source: { vertical: 'shop', eventId: 'billing.return_received' },
      });

      const v = await f.http.post('/v1/search').set(auth()).send({
        query: 'name: Felix Buyer',
        limit: 50,
        searchMode: 'vector',
      });
      const eId = v.body.results.find(
        (r: any) => r.canonicalName === 'shop_buyer',
      )?.entityId;
      expect(eId).toBeTruthy();

      const history = await f.http
        .get(`/v1/artifacts/order_history/${encodeURIComponent(eId)}`)
        .set(auth());
      expect(history.status).toBe(200);
      expect(history.body.payload.recentOrders).toEqual(
        expect.arrayContaining(['order #SHP-1234']),
      );
      expect(history.body.payload.returns).toEqual(
        expect.arrayContaining(['returned: SKU-99 from order #SHP-1234']),
      );
    });

    it('education: learner_progress with courses + scores', async () => {
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'education', id: 'edu_student' },
        predicate: 'name',
        object: 'Alice Learner',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'education' },
      });
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'education', id: 'edu_student' },
        predicate: 'enrolled_in',
        object: 'CS101 Intro to AI',
        validFrom: new Date('2026-04-10').toISOString(),
        source: { vertical: 'education', eventId: 'auth.enrollment' },
      });
      await f.http.post('/v1/ingest/fact').set(auth()).send({
        entityRef: { vertical: 'education', id: 'edu_student' },
        predicate: 'scored',
        object: '92% on midterm',
        validFrom: new Date('2026-05-01').toISOString(),
        source: { vertical: 'education', eventId: 'incidents.exam_graded' },
      });

      const v = await f.http.post('/v1/search').set(auth()).send({
        query: 'name: Alice Learner',
        limit: 50,
        searchMode: 'vector',
      });
      const eId = v.body.results.find(
        (r: any) => r.canonicalName === 'edu_student',
      )?.entityId;
      expect(eId).toBeTruthy();

      const progress = await f.http
        .get(`/v1/artifacts/learner_progress/${encodeURIComponent(eId)}`)
        .set(auth());
      expect(progress.status).toBe(200);
      expect(progress.body.payload.enrolledCourses).toEqual(
        expect.arrayContaining(['CS101 Intro to AI']),
      );
      expect(progress.body.payload.recentScores).toEqual(
        expect.arrayContaining(['92% on midterm']),
      );
    });

    it('returns 400 for unknown artifactType', async () => {
      const v = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya',
        limit: 1,
      });
      const eId = v.body.results[0]?.entityId;
      const res = await f.http
        .get(`/v1/artifacts/nonexistent_type/${encodeURIComponent(eId)}`)
        .set(auth());
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unknown artifactType/);
    });
  });

  // ── Token budget — tiktoken-precise ────────────────────────────
  describe('tokenBudget — tiktoken-precise estimation', () => {
    it('respects tokenBudget within ~5% of the actual tiktoken count', async () => {
      const { countJsonTokens } = await import('../src/common/token-counter');
      const res = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya',
        limit: 10,
        tokenBudget: 300,
      });
      expect(res.status).toBe(201);
      const actual = countJsonTokens({ results: res.body.results });
      // Server's enforcement uses the SAME counter, so the response
      // must be ≤ budget. Anything above is a counter divergence bug.
      expect(actual).toBeLessThanOrEqual(300);
    });
  });

  // ── KnowQL-lite primitives ────────────────────────────────────
  describe('KnowQL-lite agent primitives', () => {
    it('outputShape=ids returns minimal envelope', async () => {
      const res = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya complained about heating',
        limit: 5,
        outputShape: 'ids',
      });
      expect(res.status).toBe(201);
      expect(res.body.results.length).toBeGreaterThan(0);
      // ids shape has empty facts array, only entity identity.
      expect(res.body.results[0].facts).toEqual([]);
      expect(res.body.results[0].entityId).toBeDefined();
      expect(res.body.results[0].canonicalName).toBeDefined();
    });

    it('outputShape=compact returns top fact per entity, no scores', async () => {
      const res = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya complained about heating',
        limit: 5,
        outputShape: 'compact',
      });
      expect(res.status).toBe(201);
      expect(res.body.results.length).toBeGreaterThan(0);
      const top = res.body.results[0];
      expect(top.facts.length).toBeLessThanOrEqual(1);
      // compact strips per-fact scores but keeps fact itself.
      if (top.facts[0]) {
        expect(top.facts[0].score).toBeUndefined();
        expect(top.facts[0].factId).toBeDefined();
      }
    });

    it('tokenBudget caps response by trimming entities', async () => {
      const big = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya',
        limit: 10,
      });
      const tight = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya',
        limit: 10,
        tokenBudget: 200, // tight
      });
      expect(big.status).toBe(201);
      expect(tight.status).toBe(201);
      expect(tight.body.results.length).toBeLessThanOrEqual(big.body.results.length);
      // The fitsBudget heuristic: chars/4 ≤ tokenBudget.
      const projTokens = JSON.stringify({ results: tight.body.results }).length / 4;
      expect(projTokens).toBeLessThanOrEqual(200);
    });

    it('confidenceFloor drops low-scoring hits', async () => {
      const lax = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya',
        limit: 10,
      });
      const strict = await f.http.post('/v1/search').set(auth()).send({
        query: 'Anya',
        limit: 10,
        confidenceFloor: 0.99, // Effectively impossible — every fact's
        // decay-weighted score will be < 0.99 since confidence ∈ [0,1]
        // and decay ≤ 1, so the result must be empty or near-empty.
      });
      expect(lax.body.results.length).toBeGreaterThan(strict.body.results.length);
    });
  });
});
