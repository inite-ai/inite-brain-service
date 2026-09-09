/**
 * Fovea optics (Optics §4.3, docs/roadmap/fovea-optics-2026-08.md §4.3) —
 * the lens-suppression governor, e2e over a real SurrealDB (testcontainer).
 * The generator + verifier are scripted via mockSynthesizeOpenAi; the query
 * EMBEDDING goes to the real (deterministic, cached) EmbedderService, which
 * is untouched by the chat mock — so a seeded centroid equal to embed(QUERY)
 * matches the serving-time embedding with cosine 1.0.
 *
 * The trap carrier under test is the INSTRUCTION lane (memtrap-shakedown
 * class 1): with the router + instruction lane on, an "always ..." preference
 * fact renders as a generator-only "Standing instructions:" section. The
 * governor suppresses that lane for the query's class.
 *
 * Three scenarios (router + instruction lane on throughout):
 *   1. flag OFF (control tenant) → the lane reaches the prompt (baseline).
 *   2. flag ON, NO model (control tenant) → the lane STILL reaches the prompt
 *      (the load-bearing byte-identical fallback: no usable model → static).
 *   3. flag ON, a seeded model that suppresses 'instruction' near the query
 *      centroid → the lane does NOT reach the generator prompt (suppressed).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { EmbedderService } from '../src/ai/embedder.service';

describe('Fovea Optics §4.3 lens-suppression governor e2e', () => {
  // Seeded-model tenant (suppresses) and an isolated no-model tenant (control),
  // so the two scenarios cannot see each other's rows.
  let fSuppress: AppFixture;
  let fControl: AppFixture;
  const authSuppress = () => ({ Authorization: `Bearer ${fSuppress.apiKey}` });
  const authControl = () => ({ Authorization: `Bearer ${fControl.apiKey}` });

  const QUERY = 'what is the status of proj lens';
  const INSTRUCTION_MARKER = 'Standing instructions:';

  // Ingest an answerable status fact + an "always ..." instruction pref fact.
  async function seedFacts(app: AppFixture, auth: () => Record<string, string>): Promise<string> {
    const status = await app.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'proj_lens' },
        predicate: 'status',
        object: 'active launch phase',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent', messageId: 'm_lens_a' },
        confidence: 0.9,
      });
    const statusFactId = status.body.factId as string;
    expect(statusFactId).toBeTruthy();
    await app.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'proj_lens' },
        predicate: 'preferences',
        object: 'Always include code examples when I ask about implementation.',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent', messageId: 'm_lens_b' },
        confidence: 0.9,
      });
    return statusFactId;
  }

  const genFor = (factId: string) => [
    JSON.stringify({ answer: `The status is active [${factId}].`, citedFactIds: [factId] }),
    JSON.stringify({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true }),
  ];

  // Round-1 generator prompt (user message) that /v1/synthesize sent.
  async function generatorPrompt(app: AppFixture, factId: string): Promise<string> {
    const state = mockSynthesizeOpenAi(app.app, genFor(factId));
    const res = await app.http
      .post('/v1/synthesize')
      .set({ Authorization: `Bearer ${app.apiKey}` })
      .send({ query: QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(state.calls.length).toBeGreaterThanOrEqual(1);
    return state.calls[0]!.user;
  }

  async function suppressCount(app: AppFixture, outcome: string): Promise<number> {
    const metrics = app.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(
      new RegExp(`brain_lens_suppression_total\\{outcome="${outcome}"\\} (\\d+)`),
    );
    return m ? parseInt(m[1]!, 10) : 0;
  }

  beforeAll(async () => {
    delete process.env.FOVEA_LENS_SUPPRESS;
    delete process.env.FOVEA_LENS_SUPPRESS_MIN_COSINE;
    delete process.env.SYNTHESIZE_ANSWER_CACHE;
    // Router + instruction lane on so the instruction lane is in profile.lanes
    // (and thus a suppressible target).
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    process.env.SYNTHESIZE_INSTRUCTION_LANE = '1';

    fSuppress = await createApp();
    fControl = await createApp();

    const suppressFactId = await seedFacts(fSuppress, authSuppress);
    const controlFactId = await seedFacts(fControl, authControl);
    (fSuppress as unknown as { factId: string }).factId = suppressFactId;
    (fControl as unknown as { factId: string }).factId = controlFactId;

    // Seed a USABLE suppression model on the SUPPRESS tenant only: one class
    // whose centroid IS the query embedding (cosine 1.0 ≥ the 0.5 floor),
    // suppressing the instruction lane.
    const embedder = fSuppress.app.get(EmbedderService);
    const centroid = await embedder.embed(QUERY);
    expect(centroid.length).toBeGreaterThan(0);
    const surreal = fSuppress.app.get(SurrealService);
    await surreal.withCompany(fSuppress.companyId, async (db) => {
      await db.query(
        `CREATE lens_suppression CONTENT {
           companyId: $c, classId: 'default', centroid: $centroid,
           suppressLanes: ['instruction'], sampleCount: 100, version: 1
         }`,
        { c: fSuppress.companyId, centroid },
      );
    });
  });

  afterAll(async () => {
    delete process.env.FOVEA_LENS_SUPPRESS;
    delete process.env.FOVEA_LENS_SUPPRESS_MIN_COSINE;
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    delete process.env.SYNTHESIZE_INSTRUCTION_LANE;
    if (fSuppress) await fSuppress.close();
    if (fControl) await fControl.close();
  });

  it('flag OFF → the instruction lane reaches the generator prompt (baseline)', async () => {
    delete process.env.FOVEA_LENS_SUPPRESS;
    const factId = (fControl as unknown as { factId: string }).factId;
    const prompt = await generatorPrompt(fControl, factId);
    expect(prompt).toContain(INSTRUCTION_MARKER);
  });

  it('flag ON + NO model → byte-identical: the lane STILL reaches the prompt', async () => {
    process.env.FOVEA_LENS_SUPPRESS = '1';
    const factId = (fControl as unknown as { factId: string }).factId;
    const before = await suppressCount(fControl, 'no_model');
    const prompt = await generatorPrompt(fControl, factId);
    expect(prompt).toContain(INSTRUCTION_MARKER);
    // The governor engaged but found no usable model → static fallback.
    expect(await suppressCount(fControl, 'no_model')).toBe(before + 1);
  });

  it('flag ON + seeded model near the query centroid → the lane is SUPPRESSED', async () => {
    process.env.FOVEA_LENS_SUPPRESS = '1';
    const factId = (fSuppress as unknown as { factId: string }).factId;
    const before = await suppressCount(fSuppress, 'suppressed');
    const prompt = await generatorPrompt(fSuppress, factId);
    // The instruction lane was subtracted for this query's class, so its
    // generator-only section never reached the prompt.
    expect(prompt).not.toContain(INSTRUCTION_MARKER);
    expect(await suppressCount(fSuppress, 'suppressed')).toBe(before + 1);
  });

  /**
   * The centroid write guard (0132). The `fit` ingest is the only way a
   * vector enters this store, and it never passes EmbedderService — so
   * #503's cross-space write guard cannot see it. A wrong-width centroid
   * here is durable and unrepairable (no stored source text to re-embed
   * from), which is why the refusal is unconditional rather than flagged.
   */
  describe('POST /v1/admin/lens-suppression/fit — centroid space guard', () => {
    const fit = (body: object) =>
      fControl.http.post('/v1/admin/lens-suppression/fit').set(authControl()).send(body);

    const cls = (centroid: number[], extra: Record<string, unknown> = {}) => ({
      classes: [
        {
          classId: 'guard_probe',
          centroid,
          suppressLanes: ['instruction'],
          sampleCount: 10,
          ...extra,
        },
      ],
    });

    beforeEach(() => {
      process.env.FOVEA_LENS_SUPPRESS = '1';
    });

    it('refuses a wrong-width centroid with a 400', async () => {
      const embedder = fControl.app.get(EmbedderService);
      const width = embedder.primaryDimensions();
      const wrong = width === 1024 ? 1536 : 1024;
      // Declares the tenant's own space, so the WIDTH check is what fires.
      const r = await fit(
        cls(new Array(wrong).fill(0.01), { embeddingSpaceId: embedder.primarySpaceId() }),
      );
      expect(r.status).toBe(400);
      expect(String(r.body.message)).toContain(`${wrong}-wide centroid`);

      // Nothing was written: the class never appears in the listing.
      const list = await fControl.http.get('/v1/admin/lens-suppression/classes').set(authControl());
      expect(list.status).toBe(200);
      expect(
        (list.body.classes as Array<{ classId: string }>).some((c) => c.classId === 'guard_probe'),
      ).toBe(false);
    });

    it('refuses a centroid that declares a foreign space with a 400', async () => {
      const width = fControl.app.get(EmbedderService).primaryDimensions();
      const r = await fit(
        cls(new Array(width).fill(0.01), { embeddingSpaceId: 'openai:some-other-model:1536:l2' }),
      );
      expect(r.status).toBe(400);
    });

    it('refuses a centroid that declares no space with a 400 — the stamp is required', async () => {
      const width = fControl.app.get(EmbedderService).primaryDimensions();
      const r = await fit(cls(new Array(width).fill(0.01)));
      expect(r.status).toBe(400);
      expect(String(r.body.message)).toContain('embeddingSpaceId');
    });

    it('accepts a right-width centroid that declares the tenant space, and stamps it', async () => {
      const embedder = fControl.app.get(EmbedderService);
      const r = await fit(
        cls(new Array(embedder.primaryDimensions()).fill(0.01), {
          embeddingSpaceId: embedder.primarySpaceId(),
        }),
      );
      expect([200, 201]).toContain(r.status);
      expect(r.body.persisted).toBe(1);

      const list = await fControl.http.get('/v1/admin/lens-suppression/classes').set(authControl());
      const row = (
        list.body.classes as Array<{
          classId: string;
          centroidDim: number;
          embeddingSpaceId: string | null;
        }>
      ).find((c) => c.classId === 'guard_probe');
      expect(row).toBeDefined();
      expect(row!.centroidDim).toBe(embedder.primaryDimensions());
      // The stamp is the space the guard validated against — 0101's
      // descriptor, now reaching the column 0101 missed.
      expect(row!.embeddingSpaceId).toBe(embedder.primarySpaceId());
    });
  });
});
