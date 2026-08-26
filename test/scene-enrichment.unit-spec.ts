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
  parseSceneEnrichment,
  sceneEnrichmentVersion,
  SceneEnricherService,
  SCENE_SCORER_LLM_VERSION,
} from '../src/admin/scene-enricher.service';
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
    modelCalls: number;
  }

  function build(
    reply: string,
    opts: { sceneEnrichmentVersion?: string } = {},
  ): { svc: SceneEnricherService; captured: Captured } {
    const captured: Captured = { updates: [], modelCalls: 0 };
    const fakeDb = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        if (sql.includes('UPDATE $scene')) {
          captured.updates.push({ sql, params: params ?? {} });
          return [[]];
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
          create: async () => {
            captured.modelCalls += 1;
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
});
