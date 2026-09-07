/**
 * Brain v2 PR2 unit tests: the scene-enrichment reply parser (malformed →
 * null; well-formed → clamped/capped), the pure backlink intersection, the
 * enrichmentVersion composite, and the enricher service's degrade contract
 * exercised against a scripted provider stub — a malformed reply leaves
 * the scene row untouched and warns; a well-formed reply writes ONLY the
 * enriched* sibling columns + stamps (Drift-3b: the deterministic
 * gist/memoryValue are immutable post-compose); a scene already at the
 * current enrichmentVersion is skipped with zero model calls. No network,
 * no Nest, no paid calls.
 */
import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import {
  mergePredictionError,
  parseSceneEnrichment,
  sceneEnrichmentVersion,
  SceneEnricherService,
  SCENE_ENRICHMENT_SYSTEM,
  SCENE_ENRICHMENT_SYSTEM_V2,
  SCENE_SCORER_LLM_VERSION,
} from '../src/admin/scene-enricher.service';
import { SCENE_BASELINE_VERSION } from '../src/admin/scene-prediction-baseline';
import { matchFactsToScene } from '../src/admin/scene-backlink.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import type { SceneVersionService } from '../src/admin/scene-version';

const WELL_FORMED = {
  gist: 'Mika planned the Lisbon trip and booked the morning flight.',
  memoryValue: {
    novelty: 0.8,
    contradiction: 0,
    stateChange: 0.6,
    identity: 0.2,
    explicitness: 0.9,
    estimatedUtility: 0.7,
  },
  stateDeltas: [{ subject: 'mika', field: 'trip.flight', from: '', to: 'booked' }],
  unexpectedDetails: ['chose the morning slot despite hating mornings'],
  entityMentions: ['Mika', 'Lisbon'],
};

describe('parseSceneEnrichment', () => {
  it('rejects malformed payloads', () => {
    expect(parseSceneEnrichment('not json at all')).toBeNull();
    expect(parseSceneEnrichment('[]')).toBeNull();
    expect(parseSceneEnrichment(JSON.stringify({ ...WELL_FORMED, gist: '  ' }))).toBeNull();
    expect(parseSceneEnrichment(JSON.stringify({ gist: 'x' }))).toBeNull(); // no memoryValue
    expect(
      parseSceneEnrichment(
        JSON.stringify({
          ...WELL_FORMED,
          memoryValue: { ...WELL_FORMED.memoryValue, novelty: 'high' },
        }),
      ),
    ).toBeNull();
  });

  it('parses a well-formed reply, clamping dimensions into [0,1]', () => {
    const parsed = parseSceneEnrichment(
      JSON.stringify({
        ...WELL_FORMED,
        memoryValue: { ...WELL_FORMED.memoryValue, novelty: 1.7, contradiction: -0.4 },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.gist).toBe(WELL_FORMED.gist);
    expect(parsed!.memoryValue.novelty).toBe(1);
    expect(parsed!.memoryValue.contradiction).toBe(0);
    expect(parsed!.memoryValue.estimatedUtility).toBeCloseTo(0.7);
    expect(parsed!.stateDeltas).toEqual(WELL_FORMED.stateDeltas);
    expect(parsed!.unexpectedDetails).toEqual(WELL_FORMED.unexpectedDetails);
    expect(parsed!.entityMentions).toEqual(WELL_FORMED.entityMentions);
  });

  it('drops off-shape delta/detail entries instead of failing the reply', () => {
    const parsed = parseSceneEnrichment(
      JSON.stringify({
        ...WELL_FORMED,
        stateDeltas: [
          { subject: 'mika', field: 'city', from: 'Riga', to: 'Lisbon' },
          { subject: '', field: 'ghost', from: '', to: '' }, // no subject → dropped
          'not-an-object',
        ],
        unexpectedDetails: ['kept', 42, '  '],
      }),
    );
    expect(parsed!.stateDeltas).toEqual([
      { subject: 'mika', field: 'city', from: 'Riga', to: 'Lisbon' },
    ]);
    expect(parsed!.unexpectedDetails).toEqual(['kept']);
  });
});

describe('sceneEnrichmentVersion', () => {
  it('is the readable prompt|scorer|model composite', () => {
    expect(sceneEnrichmentVersion('gpt-4o-mini')).toBe(
      'scene-gist-v1|scene-scorer-llm-v1|gpt-4o-mini',
    );
  });

  it('names the prediction prompt AND both scorers with the baseline on', () => {
    expect(sceneEnrichmentVersion('gpt-4o-mini', true)).toBe(
      'scene-gist-v2|scene-scorer-llm-v1+scene-scorer-v1|gpt-4o-mini',
    );
    // Flipping the flag either way changes the idempotency key, so a
    // mixed world can never hide behind one stamp.
    expect(sceneEnrichmentVersion('m', true)).not.toBe(sceneEnrichmentVersion('m', false));
  });
});

describe('mergePredictionError', () => {
  const guessed = { ...WELL_FORMED.memoryValue };

  it('overwrites only the dimensions actually measured', () => {
    const merged = mergePredictionError(guessed, { contradiction: 1, identity: 0.5 });
    expect(merged.contradiction).toBe(1);
    expect(merged.identity).toBe(0.5);
    // Untouched: the model still owns these.
    expect(merged.stateChange).toBe(guessed.stateChange);
    expect(merged.novelty).toBe(guessed.novelty);
    expect(merged.estimatedUtility).toBe(guessed.estimatedUtility);
  });

  it('never turns an UNMEASURED dimension into a confident zero', () => {
    expect(mergePredictionError({ ...guessed, contradiction: 0.42 }, {}).contradiction).toBe(0.42);
  });

  it('clamps a measured dimension into [0,1]', () => {
    expect(mergePredictionError(guessed, { stateChange: 4 }).stateChange).toBe(1);
  });
});

describe('matchFactsToScene', () => {
  it('returns exactly the facts whose episodeIds intersect the membership', () => {
    const members = new Set(['episode:a', 'episode:b']);
    const matched = matchFactsToScene(
      [
        { id: 'knowledge_fact:1', episodeIds: ['episode:a', 'episode:z'] },
        { id: 'knowledge_fact:2', episodeIds: ['episode:z'] },
        { id: 'knowledge_fact:3', episodeIds: 'episode:a' }, // non-array → ignored
        { id: 'knowledge_fact:4' }, // absent → ignored
        { id: 'knowledge_fact:5', episodeIds: [42, 'episode:b'] },
      ],
      members,
    );
    expect(matched).toEqual(['knowledge_fact:1', 'knowledge_fact:5']);
  });
});

describe('SceneEnricherService degrade contract (scripted provider)', () => {
  const savedFlag = process.env.SCENES_LLM_ENRICHMENT;
  beforeAll(() => {
    process.env.SCENES_LLM_ENRICHMENT = '1';
  });
  afterAll(() => {
    if (savedFlag === undefined) delete process.env.SCENES_LLM_ENRICHMENT;
    else process.env.SCENES_LLM_ENRICHMENT = savedFlag;
  });

  interface Captured {
    updates: Array<{ sql: string; params: Record<string, unknown> }>;
    queries: string[];
    prompts: Array<{ system: string; user: string }>;
    modelCalls: number;
  }

  interface BuildOpts {
    sceneEnrichmentVersion?: string;
    /** Scope stamps on the single fake scene (default: single-user u1). */
    scope?: Record<string, unknown>;
    /** Rows the semantic_belief read returns (default: none). */
    beliefs?: Array<Record<string, unknown>>;
  }

  function build(
    reply: string,
    opts: BuildOpts = {},
  ): { svc: SceneEnricherService; captured: Captured } {
    const captured: Captured = { updates: [], queries: [], prompts: [], modelCalls: 0 };
    const fakeDb = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        captured.queries.push(sql);
        if (sql.includes('UPDATE $scene')) {
          captured.updates.push({ sql, params: params ?? {} });
          return [[]];
        }
        if (sql.includes('FROM semantic_belief')) {
          return [opts.beliefs ?? []];
        }
        if (sql.includes('FROM memory_episode_member')) {
          return [[{ out: 'episode:e1', ord: 0 }]];
        }
        if (sql.includes('FROM memory_episode')) {
          return [
            [
              {
                id: 'memory_episode:s1',
                conversationIds: ['conv'],
                ...(opts.scope ?? { userId: 'u1', userIds: ['u1'] }),
                ...(opts.sceneEnrichmentVersion !== undefined
                  ? { enrichmentVersion: opts.sceneEnrichmentVersion }
                  : {}),
              },
            ],
          ];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const fakeSurreal = {
      withCompany: (_c: string, fn: (db: unknown) => Promise<unknown>) => fn(fakeDb),
    } as unknown as SurrealService;
    const fakeConfig = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
    const fakeEpisodes = {
      conversationTurnsRaw: async () => [
        {
          id: 'episode:e1',
          speaker: 'mika',
          text: 'I booked the morning flight to Lisbon.',
          occurredAt: '2026-02-01T10:00:00.000Z',
        },
      ],
    } as unknown as EpisodeReadStoreService;
    const fakeVersions = {
      resolve: () => ({
        version: SEGMENTER_VERSION,
        cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
      }),
    } as unknown as SceneVersionService;
    const svc = new SceneEnricherService(fakeSurreal, fakeConfig, fakeEpisodes, fakeVersions);
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ role: string; content: string }> }) => {
            captured.modelCalls += 1;
            captured.prompts.push({
              system: req.messages.find((m) => m.role === 'system')?.content ?? '',
              user: req.messages.find((m) => m.role === 'user')?.content ?? '',
            });
            return { choices: [{ message: { content: reply } }] };
          },
        },
      },
    };
    return { svc, captured };
  }

  it('leaves the scene untouched and warns on a malformed reply', async () => {
    const { svc, captured } = build('{"gist": 12}');
    const warn = jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const result = await svc.enrich('co_test');
    expect(result).toEqual({ scenes: 1, enriched: 0, failed: 1, skipped: 0 });
    expect(captured.updates).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('writes ONLY the enriched* siblings + stamps on a well-formed reply', async () => {
    const { svc, captured } = build(JSON.stringify(WELL_FORMED));
    const result = await svc.enrich('co_test');
    expect(result).toEqual({ scenes: 1, enriched: 1, failed: 0, skipped: 0 });
    expect(captured.updates).toHaveLength(1);
    const { sql, params } = captured.updates[0]!;
    // Drift-3b contract: the deterministic originals are immutable — the
    // UPDATE touches only the revision siblings and stamps.
    expect(sql).toContain('enrichedGist = $gist');
    expect(sql).toContain('enrichedMemoryValue = $memoryValue');
    expect(sql).toContain('enrichmentModel = $model');
    expect(sql).toContain('enrichmentVersion = $enrichmentVersion');
    expect(sql).toContain('enrichedAt = time::now()');
    expect(sql).not.toMatch(/\bgist\s*=/); // never `gist =` (only enrichedGist =)
    expect(sql).not.toMatch(/\bmemoryValue\s*=/);
    expect(sql).not.toContain('gistPromptVersion'); // legacy-dead column
    expect(params.gist).toBe(WELL_FORMED.gist);
    const mv = params.memoryValue as Record<string, unknown>;
    expect(mv.scorerVersion).toBe(SCENE_SCORER_LLM_VERSION);
    expect(mv.scoredAt).toBeInstanceOf(Date);
    expect(mv.novelty).toBeCloseTo(0.8);
    expect(params.stateDeltas).toEqual(WELL_FORMED.stateDeltas);
    expect(params.unexpectedDetails).toEqual(WELL_FORMED.unexpectedDetails);
    expect(params.model).toBe('gpt-4o-mini');
    expect(params.enrichmentVersion).toBe(sceneEnrichmentVersion('gpt-4o-mini'));
  });

  it('skips a scene already at the current enrichmentVersion — zero model calls', async () => {
    const { svc, captured } = build(JSON.stringify(WELL_FORMED), {
      sceneEnrichmentVersion: sceneEnrichmentVersion('gpt-4o-mini'),
    });
    const result = await svc.enrich('co_test');
    expect(result).toEqual({ scenes: 1, enriched: 0, failed: 0, skipped: 1 });
    expect(captured.modelCalls).toBe(0);
    expect(captured.updates).toHaveLength(0);
  });

  it('re-enriches when the stamped revision differs from the current composite', async () => {
    const { svc, captured } = build(JSON.stringify(WELL_FORMED), {
      sceneEnrichmentVersion: sceneEnrichmentVersion('some-older-model'),
    });
    const result = await svc.enrich('co_test');
    expect(result).toEqual({ scenes: 1, enriched: 1, failed: 0, skipped: 0 });
    expect(captured.modelCalls).toBe(1);
  });

  it('is a no-op with the flag off', async () => {
    delete process.env.SCENES_LLM_ENRICHMENT;
    try {
      const { svc, captured } = build(JSON.stringify(WELL_FORMED));
      const result = await svc.enrich('co_test');
      expect(result).toEqual({ scenes: 0, enriched: 0, failed: 0, skipped: 0 });
      expect(captured.updates).toHaveLength(0);
    } finally {
      process.env.SCENES_LLM_ENRICHMENT = '1';
    }
  });

  // ── SCENES_PREDICTION_BASELINE OFF: byte-identical pins ──────────────
  it('with the prediction baseline OFF: no belief query, v1 prompt, no baselineRef', async () => {
    const { svc, captured } = build(JSON.stringify(WELL_FORMED));
    await svc.enrich('co_test');
    // Zero extra queries — the belief substrate is never touched.
    expect(captured.queries.some((q) => q.includes('semantic_belief'))).toBe(false);
    // The scene SELECT projection is byte-identical (no scope columns).
    const select = captured.queries.find((q) => q.includes('FROM memory_episode\n'))!;
    expect(select).toBe(
      `SELECT id, conversationIds, enrichmentVersion FROM memory_episode\n` +
        `          WHERE segmenterVersion = $v`,
    );
    // The prompt is byte-identical: v1 system, bare transcript user turn.
    expect(captured.prompts[0]!.system).toBe(SCENE_ENRICHMENT_SYSTEM);
    expect(captured.prompts[0]!.user).toBe(
      'Scene transcript:\n(2026-02-01 10:00) mika: I booked the morning flight to Lisbon.',
    );
    // The UPDATE is byte-identical and the row shape unchanged.
    const { sql, params } = captured.updates[0]!;
    expect(sql).not.toContain('baselineRef');
    expect(sql.endsWith('enrichedAt = time::now()')).toBe(true);
    expect(params.baselineRef).toBeUndefined();
    expect((params.memoryValue as Record<string, unknown>).scorerVersion).toBe(
      SCENE_SCORER_LLM_VERSION,
    );
    expect(params.enrichmentVersion).toBe('scene-gist-v1|scene-scorer-llm-v1|gpt-4o-mini');
  });
});

/**
 * SCENES_PREDICTION_BASELINE on: the expectation snapshot reaches the
 * prompt, the deterministic scorer overrides the model's guessed
 * dimensions, the snapshot is stamped as baselineRef, and no scene is
 * ever scored against another user's beliefs.
 */
describe('SceneEnricherService prediction baseline (scripted provider)', () => {
  const savedEnrich = process.env.SCENES_LLM_ENRICHMENT;
  const savedBaseline = process.env.SCENES_PREDICTION_BASELINE;
  beforeAll(() => {
    process.env.SCENES_LLM_ENRICHMENT = '1';
    process.env.SCENES_PREDICTION_BASELINE = '1';
  });
  afterAll(() => {
    for (const [k, v] of [
      ['SCENES_LLM_ENRICHMENT', savedEnrich],
      ['SCENES_PREDICTION_BASELINE', savedBaseline],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  interface Captured {
    updates: Array<{ sql: string; params: Record<string, unknown> }>;
    queries: string[];
    prompts: Array<{ system: string; user: string }>;
  }

  const BELIEF_ROW = {
    id: 'semantic_belief:b1',
    userId: 'u1',
    subject: 'mika',
    field: 'trip.flight',
    value: 'cancelled',
    revision: 2,
  };

  function build(opts: {
    reply?: string;
    scope?: Record<string, unknown>;
    beliefs?: Array<Record<string, unknown>>;
  }): { svc: SceneEnricherService; captured: Captured } {
    const captured: Captured = { updates: [], queries: [], prompts: [] };
    const fakeDb = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        captured.queries.push(sql);
        if (sql.includes('UPDATE $scene')) {
          captured.updates.push({ sql, params: params ?? {} });
          return [[]];
        }
        if (sql.includes('FROM semantic_belief')) return [opts.beliefs ?? []];
        if (sql.includes('FROM memory_episode_member')) return [[{ out: 'episode:e1', ord: 0 }]];
        if (sql.includes('FROM memory_episode')) {
          return [
            [
              {
                id: 'memory_episode:s1',
                conversationIds: ['conv'],
                ...(opts.scope ?? { userId: 'u1', userIds: ['u1'] }),
              },
            ],
          ];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const svc = new SceneEnricherService(
      {
        withCompany: (_c: string, fn: (db: unknown) => Promise<unknown>) => fn(fakeDb),
      } as unknown as SurrealService,
      { get: (_k: string, d?: unknown) => d } as unknown as ConfigService,
      {
        conversationTurnsRaw: async () => [
          {
            id: 'episode:e1',
            speaker: 'mika',
            text: 'I booked the morning flight to Lisbon.',
            occurredAt: '2026-02-01T10:00:00.000Z',
          },
        ],
      } as unknown as EpisodeReadStoreService,
      {
        resolve: () => ({
          version: SEGMENTER_VERSION,
          cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
        }),
      } as unknown as SceneVersionService,
    );
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ role: string; content: string }> }) => {
            captured.prompts.push({
              system: req.messages.find((m) => m.role === 'system')?.content ?? '',
              user: req.messages.find((m) => m.role === 'user')?.content ?? '',
            });
            return {
              choices: [{ message: { content: opts.reply ?? JSON.stringify(WELL_FORMED) } }],
            };
          },
        },
      },
    };
    return { svc, captured };
  }

  const memoryValue = (c: Captured): Record<string, unknown> =>
    c.updates[0]!.params.memoryValue as Record<string, unknown>;

  it('projects the scope columns and renders the baseline into the v2 prompt', async () => {
    const { svc, captured } = build({ beliefs: [BELIEF_ROW] });
    await svc.enrich('co_test');
    const select = captured.queries.find((q) => q.includes('FROM memory_episode\n'))!;
    expect(select).toContain('userId, userIds');
    expect(captured.prompts[0]!.system).toBe(SCENE_ENRICHMENT_SYSTEM_V2);
    expect(captured.prompts[0]!.user).toContain('Current model of the world');
    expect(captured.prompts[0]!.user).toContain('- mika | trip.flight = cancelled (revision 2)');
    expect(captured.prompts[0]!.user).toContain('Scene transcript:');
  });

  it('MEASURES contradiction against the baseline, overriding the model’s guess', async () => {
    // The model guessed contradiction 0; the belief says the flight was
    // cancelled and the delta says booked — a measured full deviation.
    const { svc, captured } = build({ beliefs: [BELIEF_ROW] });
    await svc.enrich('co_test');
    const mv = memoryValue(captured);
    expect(WELL_FORMED.memoryValue.contradiction).toBe(0); // the guess
    expect(mv.contradiction).toBe(1); // the measurement
    expect(mv.scorerVersion).toBe('scene-scorer-llm-v1+scene-scorer-v1');
    // Baseline-free dimensions are measured too; the rest stay the model's.
    expect(mv.stateChange).toBe(1); // 1 delta / 1 turn, saturated
    expect(mv.identity).toBe(1); // the delta is about the speaker
    expect(mv.novelty).toBeCloseTo(WELL_FORMED.memoryValue.novelty);
    expect(mv.estimatedUtility).toBeCloseTo(WELL_FORMED.memoryValue.estimatedUtility);
  });

  it('measures NO contradiction when the delta agrees with the belief', async () => {
    const { svc, captured } = build({ beliefs: [{ ...BELIEF_ROW, value: 'Booked ' }] });
    await svc.enrich('co_test');
    expect(memoryValue(captured).contradiction).toBe(0);
  });

  it('keeps the model’s guess when there is nothing to measure against', async () => {
    const reply = JSON.stringify({
      ...WELL_FORMED,
      memoryValue: { ...WELL_FORMED.memoryValue, contradiction: 0.42 },
    });
    const { svc, captured } = build({ reply, beliefs: [] });
    await svc.enrich('co_test');
    // An unknown baseline is NOT a confident zero — the guess survives.
    expect(memoryValue(captured).contradiction).toBeCloseTo(0.42);
    expect(captured.prompts[0]!.user).toContain('nothing is known');
  });

  it('stamps the expectation snapshot as baselineRef without touching the originals', async () => {
    const { svc, captured } = build({ beliefs: [BELIEF_ROW] });
    await svc.enrich('co_test');
    const { sql, params } = captured.updates[0]!;
    // The revision-column contract is unchanged in shape: still only the
    // enriched* siblings + stamps, plus the appended baselineRef.
    expect(sql).toContain('enrichedGist = $gist');
    expect(sql).toContain('enrichedMemoryValue = $memoryValue');
    expect(sql).toContain('baselineRef = $baselineRef');
    expect(sql).not.toMatch(/\bgist\s*=/);
    expect(sql).not.toMatch(/\bmemoryValue\s*=/);
    expect(sql).not.toContain('gistPromptVersion');
    expect(params.baselineRef).toMatchObject({
      baselineVersion: SCENE_BASELINE_VERSION,
      beliefs: [
        {
          id: 'semantic_belief:b1',
          subject: 'mika',
          field: 'trip.flight',
          value: 'cancelled',
          revision: 2,
        },
      ],
    });
    expect(typeof (params.baselineRef as Record<string, unknown>).stampedAt).toBe('string');
    expect(params.enrichmentVersion).toBe(
      'scene-gist-v2|scene-scorer-llm-v1+scene-scorer-v1|gpt-4o-mini',
    );
  });

  it.each([
    ['mixed-user', { userId: 'u1', userIds: ['u1', 'u2'] }],
    ['tenant-global', { userIds: [] }],
    ['legacy (no userIds)', { userId: 'u1' }],
  ])('never scores a %s scene against anyone’s beliefs (#387 fence)', async (_label, scope) => {
    const { svc, captured } = build({ scope, beliefs: [BELIEF_ROW] });
    await svc.enrich('co_test');
    // The fenced-out scene contributes no userId, so the belief read is
    // never even issued — zero chance of a foreign baseline.
    expect(captured.queries.some((q) => q.includes('semantic_belief'))).toBe(false);
    expect(captured.prompts[0]!.user).toContain('nothing is known');
    expect(captured.prompts[0]!.user).not.toContain('cancelled');
    // Nothing measurable ⇒ the model's contradiction guess is untouched.
    expect(memoryValue(captured).contradiction).toBe(0);
    expect((captured.updates[0]!.params.baselineRef as { beliefs: unknown[] }).beliefs).toEqual([]);
  });

  it('does not read beliefs of a DIFFERENT user even when the tenant has them', async () => {
    // The read is fenced to the scene's own user; a row for another user
    // that slipped into the result set must not land in the baseline.
    const { svc, captured } = build({
      beliefs: [{ ...BELIEF_ROW, userId: 'u2', value: 'other-user-secret' }],
    });
    await svc.enrich('co_test');
    const beliefQuery = captured.queries.find((q) => q.includes('semantic_belief'))!;
    expect(beliefQuery).toContain('userId INSIDE $userIds');
    expect(captured.prompts[0]!.user).not.toContain('other-user-secret');
    expect((captured.updates[0]!.params.baselineRef as { beliefs: unknown[] }).beliefs).toEqual([]);
  });
});
