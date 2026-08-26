/**
 * Brain v2 PR2 unit tests: the scene-enrichment reply parser (malformed →
 * null; well-formed → clamped/capped), the pure backlink intersection, and
 * the enricher service's degrade contract exercised against a scripted
 * provider stub — a malformed reply leaves the scene row untouched and
 * warns; a well-formed reply updates the row with the
 * 'scene-scorer-llm-v1' / 'scene-gist-v1' stamps. No network, no Nest, no
 * paid calls.
 */
import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import {
  parseSceneEnrichment,
  SceneEnricherService,
  SCENE_GIST_PROMPT_VERSION,
  SCENE_SCORER_LLM_VERSION,
} from '../src/admin/scene-enricher.service';
import { matchFactsToScene } from '../src/admin/scene-backlink.service';

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
    updates: Array<Record<string, unknown>>;
  }

  function build(reply: string): { svc: SceneEnricherService; captured: Captured } {
    const captured: Captured = { updates: [] };
    const fakeDb = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        if (sql.includes('FROM memory_episode WHERE')) {
          return [[{ id: 'memory_episode:s1', conversationIds: ['conv'] }]];
        }
        if (sql.includes('FROM memory_episode_member')) {
          return [[{ out: 'episode:e1', ord: 0 }]];
        }
        if (sql.includes('UPDATE $scene')) {
          captured.updates.push(params ?? {});
          return [[]];
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
    const svc = new SceneEnricherService(fakeSurreal, fakeConfig, fakeEpisodes);
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: reply } }] }),
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
    expect(result).toEqual({ scenes: 1, enriched: 0, failed: 1 });
    expect(captured.updates).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('updates the row with the scorer + prompt version stamps on a well-formed reply', async () => {
    const { svc, captured } = build(JSON.stringify(WELL_FORMED));
    const result = await svc.enrich('co_test');
    expect(result).toEqual({ scenes: 1, enriched: 1, failed: 0 });
    expect(captured.updates).toHaveLength(1);
    const update = captured.updates[0]!;
    expect(update.gist).toBe(WELL_FORMED.gist);
    expect(update.gistPromptVersion).toBe(SCENE_GIST_PROMPT_VERSION);
    const mv = update.memoryValue as Record<string, unknown>;
    expect(mv.scorerVersion).toBe(SCENE_SCORER_LLM_VERSION);
    expect(mv.scoredAt).toBeInstanceOf(Date);
    expect(mv.novelty).toBeCloseTo(0.8);
    expect(update.stateDeltas).toEqual(WELL_FORMED.stateDeltas);
    expect(update.unexpectedDetails).toEqual(WELL_FORMED.unexpectedDetails);
  });

  it('is a no-op with the flag off', async () => {
    delete process.env.SCENES_LLM_ENRICHMENT;
    try {
      const { svc, captured } = build(JSON.stringify(WELL_FORMED));
      const result = await svc.enrich('co_test');
      expect(result).toEqual({ scenes: 0, enriched: 0, failed: 0 });
      expect(captured.updates).toHaveLength(0);
    } finally {
      process.env.SCENES_LLM_ENRICHMENT = '1';
    }
  });
});
