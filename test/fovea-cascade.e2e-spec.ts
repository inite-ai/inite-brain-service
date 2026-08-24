/**
 * Fovea cascade shakedown — the FULL foveated-memory stack composed.
 *
 * Every fovea lever shipped this cycle default-OFF and carries its own
 * per-feature e2e, but they were NEVER booted together. This spec boots
 * ONE app with the whole stack ON at once and drives a sequence of
 * requests through the composed pipeline:
 *
 *   L2 raw windows (RETRIEVAL_RAW_WINDOW) · L3 escalation
 *   (RETRIEVAL_L3_ESCALATION) · answer cache (SYNTHESIZE_ANSWER_CACHE) ·
 *   strategy lane (STRATEGY_MEMORY_ENABLED + STRATEGY_RETRIEVAL_ENABLED +
 *   the answer router) · scope tags (SCOPE_TAGS_ENABLED) · char-span
 *   provenance (DERIVER_SPANS) · usage recording+ranking
 *   (SEARCH_USAGE_RECORDING_ENABLED + SEARCH_USAGE_RANKING_ENABLED +
 *   SEARCH_USAGE_BETA) · constrained search loop (RETRIEVAL_SEARCH_LOOP).
 *
 * This is FREE functional verification (the generator/verifier are
 * scripted via mockSynthesizeOpenAi, the embedder/extractor are stubs) —
 * distinct from benchmark scoring. It proves the levers WORK and COMPOSE,
 * not that they raise a score.
 *
 * Retrieval isolation doctrine: every fact is user-scoped to a
 * per-scenario end-user, so one scenario's facts never leak into
 * another's retrieval (and the L3 coverage floor stays deterministic).
 * Episodes are tenant-global (scope=[] by the 0093 schema default), so
 * they stay visible to a user-scoped read exactly as production episodes
 * written through ingest would.
 *
 * COMPOSITION NOTE proven by scenarios 3+4: with the search loop ON, the
 * L3 ladder's `skip_no_refine` guard (l3-escalation.ts) means L3 cannot
 * reach the anchor check until a search-loop refine round has already
 * run — a real cross-flag dependency the search-loop-OFF per-feature L3
 * test never exercises.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { StrategyMemoryService } from '../src/strategy/strategy-memory.service';
import { StringRecordId } from 'surrealdb';

/** The full fovea flag stack, turned ON together for the whole suite. */
const FLAG_ENV: Record<string, string> = {
  // L2 raw windows.
  RETRIEVAL_RAW_WINDOW: '1',
  RETRIEVAL_RAW_WINDOW_SPAN: '2',
  // L3 escalation.
  RETRIEVAL_L3_ESCALATION: '1',
  RETRIEVAL_L3_MAX_SESSIONS: '3',
  RETRIEVAL_L3_TOKEN_CAP: '60000',
  // Answer cache.
  SYNTHESIZE_ANSWER_CACHE: '1',
  SYNTHESIZE_ANSWER_CACHE_TTL_HOURS: '24',
  // Strategy lane (needs the answer router to enter the lane set).
  STRATEGY_MEMORY_ENABLED: '1',
  STRATEGY_RETRIEVAL_ENABLED: '1',
  SYNTHESIZE_ANSWER_ROUTER_ENABLED: '1',
  // Scope tags.
  SCOPE_TAGS_ENABLED: '1',
  // Char-span provenance (read side; provenance route needs FACTS_API).
  DERIVER_SPANS: '1',
  FACTS_API_ENABLED: '1',
  // Usage recording + ranking.
  SEARCH_USAGE_RECORDING_ENABLED: '1',
  SEARCH_USAGE_RANKING_ENABLED: '1',
  SEARCH_USAGE_BETA: '0.2',
  // Constrained search loop.
  RETRIEVAL_SEARCH_LOOP: '1',
};

interface CacheRow {
  hitCount: number;
  invalidationCause?: string | null;
  userId?: string | null;
  answer: string;
}

interface UsageRow {
  readCount: number;
  lastReadAt: string;
}

describe('fovea cascade shakedown — full stack composed', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedEnv: Record<string, string | undefined> = {};

  // One fact per scenario, each user-scoped for retrieval isolation.
  let baseFactId: string;
  let cacheFactId: string;
  let anchorFactId: string;
  let scopeFactId: string;
  let usageFactId: string;

  const L3_ANSWER = 'The tier is sapphire-crest-l3, per the full session.';
  const STRATEGY_TEXT = 'Prefer the archival ledger over ad-hoc recall.';

  // ── helpers ──────────────────────────────────────────────────────
  const synth = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ limit: 5, ...body });

  const ingestFact = async (body: Record<string, unknown>): Promise<string> => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        validFrom: new Date('2026-04-01').toISOString(),
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        ...body,
      });
    expect([200, 201]).toContain(r.status);
    expect(r.body.factId).toBeTruthy();
    return r.body.factId as string;
  };

  async function metricValue(name: string, outcome: string): Promise<number> {
    const metrics = f.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(new RegExp(`${name}\\{outcome="${outcome}"\\} (\\d+)`));
    return m ? parseInt(m[1]!, 10) : 0;
  }
  const l3Count = (o: string) => metricValue('brain_l3_escalation_total', o);
  const cacheMetric = (o: string) => metricValue('brain_answer_cache_total', o);

  async function cacheRows(): Promise<CacheRow[]> {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[CacheRow[]]>('SELECT * FROM answer_cache');
      return rows ?? [];
    });
  }

  const usageFor = async (factId: string): Promise<UsageRow | null> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[UsageRow[]]>(
        `SELECT readCount, lastReadAt FROM fact_usage
          WHERE factId = type::record('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      return (rows as UsageRow[])?.[0] ?? null;
    });
  };
  const waitForCount = async (factId: string, atLeast: number): Promise<UsageRow | null> => {
    for (let i = 0; i < 40; i++) {
      const row = await usageFor(factId);
      if (row && row.readCount >= atLeast) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
    return usageFor(factId);
  };

  beforeAll(async () => {
    for (const k of Object.keys(FLAG_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = FLAG_ENV[k]!;
    }
    f = await createApp({ companyId: 'co_fovea_cascade_e2e' });

    // Per-scenario user-scoped facts.
    baseFactId = await ingestFact({
      entityRef: { vertical: 'rent', id: 'cust_base' },
      predicate: 'role',
      object: 'quantum-archivist',
      userId: 'u_base',
    });
    cacheFactId = await ingestFact({
      entityRef: { vertical: 'rent', id: 'cust_cache' },
      predicate: 'tier',
      object: 'sapphire-cache',
      userId: 'u_cache',
    });
    anchorFactId = await ingestFact({
      entityRef: { vertical: 'rent', id: 'cust_l3' },
      predicate: 'tier',
      object: 'sapphire-crest-l3',
      userId: 'u_l3',
    });
    // Lonely fact — retrievable but grounds in NO session (scenario 4);
    // its id is never referenced, only its retrievability matters.
    await ingestFact({
      entityRef: { vertical: 'rent', id: 'cust_lonely' },
      predicate: 'status',
      object: 'meridian-lonely-l3',
      userId: 'u_lonely',
    });
    scopeFactId = await ingestFact({
      entityRef: { vertical: 'rent', id: 'cust_scope' },
      predicate: 'secret',
      object: 'obsidian-scope-marker',
      userId: 'user_a',
    });
    usageFactId = await ingestFact({
      entityRef: { vertical: 'rent', id: 'cust_usage' },
      predicate: 'tier',
      object: 'quantum-usage',
      userId: 'u_usage',
    });

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      // L3 anchoring session for the anchored fact.
      await db.query(
        `CREATE episode:fcep1 CONTENT {
           kind: 'turn', messageId: 'm_fc_a', conversationId: 'conv_fovea',
           speaker: 'user', text: $t1, occurredAt: $o1, source: {}
         };
         CREATE episode:fcep2 CONTENT {
           kind: 'turn', messageId: 'm_fc_a2', conversationId: 'conv_fovea',
           speaker: 'assistant', text: $t2, occurredAt: $o2, source: {}
         }`,
        {
          t1: 'My tier is sapphire-crest-l3, I confirmed it last week.',
          t2: 'Understood — you are on sapphire-crest-l3.',
          o1: new Date('2026-04-01T10:00:00Z'),
          o2: new Date('2026-04-01T10:01:00Z'),
        },
      );
      await db.query(`UPDATE $rid SET source.episodeIds = ['episode:fcep1', 'episode:fcep2']`, {
        rid: new StringRecordId(anchorFactId),
      });

      // DERIVER_SPANS grounding turn + char span for the usage fact.
      await db.query(
        `CREATE episode:fcspan1 CONTENT {
           kind: 'turn', messageId: 'm_fc_span', conversationId: 'conv_span',
           speaker: 'user', text: $t, occurredAt: $o, source: {}
         }`,
        { t: 'My tier is quantum-usage as of April.', o: new Date('2026-04-01T09:00:00Z') },
      );
      await db.query(
        `UPDATE $rid SET
           source.episodeIds = ['episode:fcspan1'],
           source.charSpans = [{ episodeId: 'episode:fcspan1', start: 11, end: 24, exact: 'quantum-usage' }]`,
        { rid: new StringRecordId(usageFactId) },
      );
    });

    // Active strategy item — title equals the baseline query so the
    // StubEmbedder's identical-text property clears the similarity floor.
    await f.app.get(StrategyMemoryService).create(f.companyId, {
      title: 'quantum-archivist',
      situation: '',
      strategy: STRATEGY_TEXT,
      polarity: 'do',
      status: 'active',
    });
  });

  afterAll(async () => {
    for (const k of Object.keys(FLAG_ENV)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (f) await f.close();
  });

  // ── 1. Composition boot + grounded answer + strategy composes ─────
  it('boots clean with the full stack and returns a grounded answer (strategy note composes, no leak)', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'The role is quantum-archivist.', citedFactIds: [baseFactId] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true }),
    ]);
    const res = await synth({ query: 'quantum-archivist', userId: 'u_base' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe('The role is quantum-archivist.');
    expect(res.body.cached).toBeUndefined();
    // Round-1 generate + verify only — no refine (round-1 returned no refineQuery).
    expect(state.calls.length).toBe(2);
    expect(res.body.citations?.[0]?.factId).toBe(baseFactId);

    // Strategy lane composed: the generator saw the fenced advisory note;
    // the verifier (parity exception) did not.
    expect(state.calls[0]!.user).toContain('=== ADVISORY STRATEGY NOTES');
    expect(state.calls[0]!.user).toContain(STRATEGY_TEXT);
    expect(state.calls[1]!.user).not.toContain('ADVISORY STRATEGY NOTES');
    // Leakage guard: strategy rows never reach citations.
    expect(JSON.stringify(res.body.citations ?? [])).not.toContain('strategy_memory');
    expect(JSON.stringify(res.body.citations ?? [])).not.toContain(STRATEGY_TEXT);
  });

  // ── 2. Answer cache serve + invalidate under the full stack ───────
  it('caches a grounded answer, serves it on repeat, and invalidates when a cited fact is retracted', async () => {
    const CACHE_QUERY = 'sapphire-cache';

    const s1 = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'The tier is sapphire-cache.', citedFactIds: [cacheFactId] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true }),
    ]);
    const r1 = await synth({ query: CACHE_QUERY, userId: 'u_cache' });
    expect(r1.status).toBe(201);
    expect(r1.body.answer).toBe('The tier is sapphire-cache.');
    expect(r1.body.cached).toBeUndefined();
    expect(s1.calls.length).toBe(2);

    // Repeat (typographic variant): served from cache, LLM never called.
    const hitBefore = await cacheMetric('hit');
    const s2 = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: 'A DIFFERENT answer that must not surface.',
        citedFactIds: [cacheFactId],
      }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const r2 = await synth({ query: `  ${CACHE_QUERY.toUpperCase()}?`, userId: 'u_cache' });
    expect(r2.status).toBe(201);
    expect(r2.body.cached).toBe(true);
    expect(r2.body.answer).toBe('The tier is sapphire-cache.');
    expect(s2.calls.length).toBe(0);
    expect(await cacheMetric('hit')).toBe(hitBefore + 1);

    // Retract the cited fact → check-on-read invalidates → re-synthesis.
    const retract = await f.http
      .post(`/v1/facts/${encodeURIComponent(cacheFactId)}/retract`)
      .set(auth())
      .send({ reason: 'operator correction', retractedBy: { source: 'human' } });
    expect(retract.status).toBe(201);

    mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'Fresh post-retraction answer.', citedFactIds: [cacheFactId] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const r3 = await synth({ query: CACHE_QUERY, userId: 'u_cache' });
    expect(r3.status).toBe(201);
    expect(r3.body.cached).toBeUndefined();
    expect(r3.body.answer).not.toBe('The tier is sapphire-cache.');

    const rows = (await cacheRows()).filter((r) => r.userId === 'u_cache');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invalidationCause).toBe('retracted');
  });

  // ── 3. L3 fires on verifier-fail + anchor (after the refine round) ─
  it('escalates to L3 on verifier-fail with an anchor and returns the flipped answer (single-shot)', async () => {
    const firedBefore = await l3Count('fired');
    const flippedBefore = await l3Count('flipped');
    // Under the search loop, the round-1 refineQuery forces the ONE
    // refine round; only then can the L3 trigger clear skip_no_refine.
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: 'A thin, unsupported guess.',
        citedFactIds: [],
        refineQuery: 'sapphire crest tier full detail',
      }),
      JSON.stringify({ answer: 'Still thin after the refine round.', citedFactIds: [] }),
      JSON.stringify({
        verdict: 'unsupported',
        unsupportedClaims: ['Still thin after the refine round.'],
        questionAnswered: false,
      }),
      JSON.stringify({ answer: L3_ANSWER, citedFactIds: [anchorFactId] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true }),
    ]);
    const res = await synth({ query: 'what is the tier sapphire-crest-l3', userId: 'u_l3' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(L3_ANSWER);
    expect(res.body.cached).toBeUndefined();
    // round-1 gen + refined gen + verify + L3 gen + L3 verify.
    expect(state.calls.length).toBe(5);
    // The L3 generator saw the raw full-session transcript.
    expect(state.calls[3]!.user).toContain('Full conversation transcripts');
    expect(state.calls[3]!.user).toContain('conv_fovea');
    // Monotone single-shot: exactly one fire, one flip.
    expect(await l3Count('fired')).toBe(firedBefore + 1);
    expect(await l3Count('flipped')).toBe(flippedBefore + 1);
  });

  // ── 4. L3 skips without an anchor ─────────────────────────────────
  it('fires the L3 trigger but skips (no anchor) when the retrieved fact names no session', async () => {
    const skipBefore = await l3Count('skipped_no_anchor');
    const firedBefore = await l3Count('fired');
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: 'thin guess',
        citedFactIds: [],
        refineQuery: 'meridian status full detail',
      }),
      JSON.stringify({ answer: 'still thin', citedFactIds: [] }),
      JSON.stringify({
        verdict: 'unsupported',
        unsupportedClaims: ['still thin'],
        questionAnswered: false,
      }),
      '{}',
      '{}',
    ]);
    const res = await synth({ query: 'what is the status meridian-lonely-l3', userId: 'u_lonely' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBeNull();
    // round-1 gen + refined gen + verify — NO full-context L3 call burned.
    expect(state.calls.length).toBe(3);
    expect(await l3Count('skipped_no_anchor')).toBe(skipBefore + 1);
    expect(await l3Count('fired')).toBe(firedBefore);
  });

  // ── 5. Scope isolation holds across the cache + L3 read paths ─────
  it('never serves or retrieves across users: user B sees nothing of user A under the full stack', async () => {
    const SCOPE_QUERY = 'obsidian-scope-marker';

    // User A: grounded + admitted to the cache under user_a's partition.
    const sa = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: 'The secret is obsidian-scope-marker.',
        citedFactIds: [scopeFactId],
      }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true }),
    ]);
    const ra = await synth({ query: SCOPE_QUERY, userId: 'user_a' });
    expect(ra.status).toBe(201);
    expect(ra.body.answer).toBe('The secret is obsidian-scope-marker.');
    expect(ra.body.cached).toBeUndefined();
    expect(sa.calls.length).toBe(2);

    // User B, identical query: MUST NOT hit user A's cache entry, and
    // MUST NOT retrieve user A's fact → no grounded answer.
    mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'user B must not get user A content', citedFactIds: [] }),
      JSON.stringify({ verdict: 'unsupported', unsupportedClaims: [], questionAnswered: false }),
    ]);
    const rb = await synth({ query: SCOPE_QUERY, userId: 'user_b' });
    expect(rb.status).toBe(201);
    expect(rb.body.cached).toBeUndefined();
    expect(rb.body.answer).not.toBe('The secret is obsidian-scope-marker.');

    // Direct search fence: A sees its own row, B sees none of it.
    const objectsFor = async (userId: string): Promise<string[]> => {
      const r = await f.http
        .post('/v1/search')
        .set(auth())
        .send({ query: SCOPE_QUERY, limit: 10, userId });
      expect(r.status).toBe(201);
      return (r.body.results as Array<{ facts?: Array<{ object: string }> }>)
        .flatMap((h) => h.facts ?? [])
        .map((fa) => fa.object);
    };
    expect(await objectsFor('user_a')).toContain('obsidian-scope-marker');
    expect(await objectsFor('user_b')).not.toContain('obsidian-scope-marker');
  });

  // ── 6. Spans + usage compose (light — prove no interference) ──────
  it('accrues usage readCount and surfaces char-span provenance without interference', async () => {
    // Two searches accrue readCount; usage-ranking (beta>0) must not
    // break the result set.
    const s1 = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'quantum-usage', limit: 5, userId: 'u_usage' });
    expect(s1.status).toBe(201);
    expect((s1.body.results ?? []).length).toBeGreaterThan(0);
    const s2 = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'quantum-usage', limit: 5, userId: 'u_usage' });
    expect(s2.status).toBe(201);
    expect((s2.body.results ?? []).length).toBeGreaterThan(0);

    const usage = await waitForCount(usageFactId, 2);
    expect(usage).not.toBeNull();
    expect(usage!.readCount).toBeGreaterThanOrEqual(2);

    // DERIVER_SPANS read path: the provenance surfaces the char span.
    const prov = await f.http
      .get(`/v1/facts/${encodeURIComponent(usageFactId)}/provenance`)
      .set(auth());
    expect(prov.status).toBe(200);
    const episodes = (prov.body.episodes ?? []) as Array<{
      span?: { start: number; end: number; exact: string };
    }>;
    const spanned = episodes.find((e) => e.span);
    expect(spanned).toBeTruthy();
    expect(spanned!.span!.exact).toBe('quantum-usage');
  });
});
