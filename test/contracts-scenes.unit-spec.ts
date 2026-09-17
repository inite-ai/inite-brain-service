/**
 * Wire-contract drift guard for GET /v1/scenes/:id and GET /v1/scenes
 * (the contracts-beliefs idiom): fully-populated samples typed against
 * the SERVICE result interfaces, parsed against the zod wire contracts,
 * then pinned key-for-key.
 */
import {
  SceneReadResponseSchema,
  ScenesListResponseSchema,
} from '../src/contracts/scenes/scenes.schema';
import type { SceneReadResult, ScenesListResult } from '../src/scenes/scenes.service';

const expectKeys = (shape: Record<string, unknown>, sample: Record<string, unknown>) =>
  expect(Object.keys(shape).sort()).toEqual(Object.keys(sample).sort());

const fullScene: Required<SceneReadResult> = {
  sceneId: 'memory_episode:s1',
  userId: 'user-1',
  userIds: ['user-1'],
  sceneLabel: 'Signed the lease',
  gist: '2026-07-01 10:00–10:01 · user-1 · 2 turns — opens: "Signed the lease"',
  enrichedGist: 'The flat lease was signed and keys are due Friday.',
  occurredFrom: '2026-07-01T10:00:00.000Z',
  occurredTo: '2026-07-01T10:01:00.000Z',
  recordedAt: '2026-07-01T10:02:00.000Z',
  conversationIds: ['proj:c1'],
  episodeIds: ['episode:e1', 'episode:e2'],
  entityIds: ['knowledge_entity:flat'],
  factIds: ['knowledge_fact:f1'],
  unexpectedDetails: ['keys arrive before the deposit clears'],
  stateDeltas: [{ subject: 'mika', field: 'home.city', from: 'lisbon', to: 'porto' }],
  memoryValue: {
    novelty: 0.4,
    contradiction: 0,
    stateChange: 0.9,
    identity: 0.2,
    explicitness: 0.8,
    estimatedUtility: 0.7,
    scorerVersion: 'scene-scorer-llm-v1',
  },
  confidence: 1,
  segmenterVersion: 'scene-segmenter-v1',
  enriched: true,
};

const fullList: Required<ScenesListResult> = {
  scenes: [fullScene],
  found: 1,
  world: 'scene-segmenter-v1',
};

describe('scenes wire contracts', () => {
  it('SceneReadResponseSchema parses a fully-populated service result', () => {
    expect(SceneReadResponseSchema.safeParse(fullScene).success).toBe(true);
  });

  it('SceneReadResponseSchema parses the minimal shape (optionals absent)', () => {
    const { userId, enrichedGist, memoryValue, ...minimal } = fullScene;
    void userId;
    void enrichedGist;
    void memoryValue;
    expect(SceneReadResponseSchema.safeParse(minimal).success).toBe(true);
  });

  it('SceneReadResponseSchema covers every service field — both directions', () => {
    expectKeys(SceneReadResponseSchema.shape, fullScene);
  });

  it('ScenesListResponseSchema parses and covers the list result', () => {
    expect(ScenesListResponseSchema.safeParse(fullList).success).toBe(true);
    expectKeys(ScenesListResponseSchema.shape, fullList);
  });
});
