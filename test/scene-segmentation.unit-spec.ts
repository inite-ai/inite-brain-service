/**
 * Pure-function tests for the Brain v2 scene segmenter
 * (src/admin/scene-segmentation.ts): boundary detection (session gap via
 * the shared segmentSessions, cosine topic split, min scene size,
 * max-turns force split, determinism), the deterministic gist/label
 * renders, the deterministic memory-value scorer, and the scope/PII fold
 * (segment-composer :147-160 rule).
 */
import {
  boundaryConfidence,
  deriveSceneConfidence,
  detectSceneBoundaries,
  detectSceneSegments,
  effectiveSegmenterVersion,
  foldSceneScope,
  meanVector,
  renderSceneGist,
  renderSceneLabel,
  sceneConfigFingerprint,
  scoreSceneDeterministic,
  SCENE_SCORER_VERSION,
  type SceneBoundary,
  type SceneSegment,
  type SceneSegmenterConfig,
  type SceneTurnRow,
} from '../src/admin/scene-segmentation';
import { segmentSessions } from '../src/episodes/session-window';

let seq = 0;
function turn(over: Partial<SceneTurnRow> & { text: string }): SceneTurnRow {
  seq += 1;
  return {
    id: `episode:t${seq}`,
    speaker: 'mika',
    occurredAt: '2026-01-01T10:00:00.000Z',
    ...over,
  };
}

const at = (iso: string, text: string, over: Partial<SceneTurnRow> = {}) =>
  turn({ occurredAt: iso, text, ...over });

const OPTS = { minCosine: 0.55, maxTurns: 40 };

describe('detectSceneBoundaries', () => {
  it('session gap always splits (via segmentSessions), each session is one scene', () => {
    const turns = [
      at('2026-01-01T10:00:00.000Z', 'planning the trip'),
      at('2026-01-01T10:05:00.000Z', 'looking at flights'),
      at('2026-01-01T10:10:00.000Z', 'found a good one'),
      // > 60 min inactivity gap ⇒ a new session, hence a scene boundary.
      at('2026-01-01T12:00:00.000Z', 'back from lunch'),
      at('2026-01-01T12:05:00.000Z', 'booking the hotel'),
    ];
    const sessions = segmentSessions(turns) as SceneTurnRow[][];
    expect(sessions).toHaveLength(2);
    const scenes = sessions.flatMap((s) => detectSceneBoundaries(s, undefined, OPTS));
    expect(scenes.map((s) => s.length)).toEqual([3, 2]);
    expect(scenes[0]![0]!.text).toBe('planning the trip');
    expect(scenes[1]![0]!.text).toBe('back from lunch');
  });

  it('splits within a session when cosine drops below the floor', () => {
    const session = [
      at('2026-01-01T10:00:00.000Z', 'a1'),
      at('2026-01-01T10:01:00.000Z', 'a2'),
      at('2026-01-01T10:02:00.000Z', 'a3'),
      at('2026-01-01T10:03:00.000Z', 'b1'),
      at('2026-01-01T10:04:00.000Z', 'b2'),
      at('2026-01-01T10:05:00.000Z', 'b3'),
    ];
    // Topic A on one axis, topic B orthogonal: cos(mean(a), b1) = 0 < 0.55.
    const embeddings = [
      [1, 0],
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 1],
      [0, 1],
    ];
    const scenes = detectSceneBoundaries(session, embeddings, OPTS);
    expect(scenes.map((s) => s.map((t) => t.text))).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
  });

  it('never cosine-splits a scene below the 2-turn minimum', () => {
    const session = [at('2026-01-01T10:00:00.000Z', 'a1'), at('2026-01-01T10:01:00.000Z', 'b1')];
    // Orthogonal from the very first pair — still one scene of two.
    const scenes = detectSceneBoundaries(
      session,
      [
        [1, 0],
        [0, 1],
      ],
      OPTS,
    );
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toHaveLength(2);
  });

  it('force-splits at maxTurns even without embeddings', () => {
    const session = Array.from({ length: 5 }, (_, i) => at(`2026-01-01T10:0${i}:00.000Z`, `t${i}`));
    const scenes = detectSceneBoundaries(session, undefined, { minCosine: 0.55, maxTurns: 2 });
    expect(scenes.map((s) => s.length)).toEqual([2, 2, 1]);
  });

  it('is deterministic', () => {
    const session = Array.from({ length: 7 }, (_, i) => at(`2026-01-01T10:0${i}:00.000Z`, `t${i}`));
    const embeddings = session.map((_, i) => (i < 4 ? [1, 0] : [0, 1]));
    const a = detectSceneBoundaries(session, embeddings, OPTS);
    const b = detectSceneBoundaries(session, embeddings, OPTS);
    expect(a).toEqual(b);
  });
});

describe('detectSceneSegments — edge provenance', () => {
  it('is the same segmentation as detectSceneBoundaries, plus the edges', () => {
    const session = Array.from({ length: 7 }, (_, i) => at(`2026-01-01T10:0${i}:00.000Z`, `t${i}`));
    const embeddings = session.map((_, i) => (i < 4 ? [1, 0] : [0, 1]));
    const segments = detectSceneSegments(session, embeddings, OPTS);
    expect(segments.map((s) => s.turns)).toEqual(detectSceneBoundaries(session, embeddings, OPTS));
  });

  it('names the rule that made each edge; outer edges are the session', () => {
    const session = Array.from({ length: 6 }, (_, i) => at(`2026-01-01T10:0${i}:00.000Z`, `t${i}`));
    const embeddings = session.map((_, i) => (i < 3 ? [1, 0] : [0, 1]));
    const segments = detectSceneSegments(session, embeddings, OPTS);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.startBoundary).toEqual({ kind: 'session' });
    // The SAME edge ends the first scene and starts the second.
    expect(segments[0]!.endBoundary.kind).toBe('topic-cosine');
    expect(segments[0]!.endBoundary.cosine).toBeCloseTo(0, 10);
    expect(segments[1]!.startBoundary).toEqual(segments[0]!.endBoundary);
    expect(segments[1]!.endBoundary).toEqual({ kind: 'session' });
  });

  it('the max-turns cap is named as its own (exact) rule', () => {
    const session = Array.from({ length: 5 }, (_, i) => at(`2026-01-01T10:0${i}:00.000Z`, `t${i}`));
    const segments = detectSceneSegments(session, undefined, { minCosine: 0.55, maxTurns: 2 });
    expect(segments.map((s) => s.endBoundary.kind)).toEqual(['max-turns', 'max-turns', 'session']);
    expect(segments.every((s) => s.endBoundary.cosine === undefined)).toBe(true);
  });
});

describe('scene confidence derivation', () => {
  const segment = (start: SceneBoundary, end: SceneBoundary): SceneSegment<SceneTurnRow> => ({
    turns: [],
    startBoundary: start,
    endBoundary: end,
  });
  const SESSION: SceneBoundary = { kind: 'session' };
  const CAP: SceneBoundary = { kind: 'max-turns' };
  const ON = { minCosine: 0.55, topicBoundary: true };

  it('an EXACT rule is certain: session gap and turn cap both score 1', () => {
    expect(boundaryConfidence(SESSION, 0.55)).toBe(1);
    expect(boundaryConfidence(CAP, 0.55)).toBe(1);
    expect(deriveSceneConfidence(segment(SESSION, SESSION), ON)).toBe(1);
    expect(deriveSceneConfidence(segment(SESSION, CAP), ON)).toBe(1);
  });

  it('a cosine edge scores by its margin below the floor', () => {
    // 0.5 + 0.5·(0.55 − 0)/1.55
    expect(boundaryConfidence({ kind: 'topic-cosine', cosine: 0 }, 0.55)).toBeCloseTo(0.677419, 6);
    // Maximally opposed turns: the full span, hence 1.
    expect(boundaryConfidence({ kind: 'topic-cosine', cosine: -1 }, 0.55)).toBeCloseTo(1, 10);
    // Barely below the floor: a coin-flip boundary, and the row says so.
    expect(boundaryConfidence({ kind: 'topic-cosine', cosine: 0.5499 }, 0.55)).toBeCloseTo(0.5, 4);
  });

  it('stays inside [0.5, 1] for every reachable input', () => {
    for (const cosine of [-1, -0.9, -0.5, 0, 0.2, 0.4, 0.5499]) {
      const c = boundaryConfidence({ kind: 'topic-cosine', cosine }, 0.55);
      expect(c).toBeGreaterThanOrEqual(0.5);
      expect(c).toBeLessThanOrEqual(1);
    }
    // Degenerate floor: no cosine can fall below -1, so the edge cannot
    // exist — the guard must not divide by a zero-width span.
    expect(boundaryConfidence({ kind: 'topic-cosine', cosine: -1 }, -1)).toBe(1);
  });

  it('a scene is only as sure as its WEAKER edge', () => {
    const strong: SceneBoundary = { kind: 'topic-cosine', cosine: -1 };
    const weak: SceneBoundary = { kind: 'topic-cosine', cosine: 0.5 };
    const both = deriveSceneConfidence(segment(strong, weak), ON);
    expect(both).toBeCloseTo(boundaryConfidence(weak, 0.55), 10);
    expect(both).toBeLessThan(boundaryConfidence(strong, 0.55));
    // A single soft edge is enough to pull a session-delimited scene down.
    expect(deriveSceneConfidence(segment(SESSION, weak), ON)).toBeCloseTo(both, 10);
  });

  it('PIN: with the topic boundary OFF every scene is exactly 1', () => {
    const off = { minCosine: 0.55, topicBoundary: false };
    const edges: SceneBoundary[] = [
      SESSION,
      CAP,
      { kind: 'topic-cosine', cosine: 0 },
      { kind: 'topic-cosine', cosine: 0.5499 },
    ];
    for (const start of edges) {
      for (const end of edges) {
        expect(deriveSceneConfidence(segment(start, end), off)).toBe(1);
      }
    }
  });

  it('end to end: a real cosine split lands a sub-1 confidence on both halves', () => {
    const session = Array.from({ length: 6 }, (_, i) => at(`2026-01-01T10:0${i}:00.000Z`, `t${i}`));
    const embeddings = session.map((_, i) => (i < 3 ? [1, 0] : [0, 1]));
    const segments = detectSceneSegments(session, embeddings, OPTS);
    const derived = segments.map((s) => deriveSceneConfidence(s, ON));
    expect(derived).toHaveLength(2);
    for (const c of derived) expect(c).toBeCloseTo(0.677419, 6);
    // The same segments under an embedder-free run are certain.
    expect(
      detectSceneSegments(session, undefined, OPTS).map((s) =>
        deriveSceneConfidence(s, { minCosine: 0.55, topicBoundary: false }),
      ),
    ).toEqual([1]);
  });
});

describe('renderSceneGist / renderSceneLabel', () => {
  const scene = [
    at('2026-03-05T09:30:00.000Z', 'I moved to Lisbon last week', { speaker: 'mika' }),
    at('2026-03-05T09:31:00.000Z', 'Congrats! How is the flat?', { speaker: 'chat__assistant' }),
    at('2026-03-05T09:40:00.000Z', 'Small but sunny', { speaker: 'mika' }),
  ];

  it('renders the canonical gist text', () => {
    expect(renderSceneGist(scene)).toBe(
      '2026-03-05 09:30–09:40 · mika, chat__assistant · 3 turns — ' +
        'opens: "I moved to Lisbon last week" — closes: "Small but sunny"',
    );
  });

  it('truncates opener/closer to 160 chars deterministically', () => {
    const long = 'x'.repeat(500);
    const gist = renderSceneGist([at('2026-03-05T09:30:00.000Z', long)]);
    const quoted = /opens: "([^"]*)"/.exec(gist)![1]!;
    expect(quoted).toHaveLength(160);
  });

  it('labels from the first NON-assistant turn, trimmed to 80', () => {
    const assistantFirst = [
      at('2026-03-05T09:30:00.000Z', 'Here is your daily summary', { speaker: 'chat__assistant' }),
      at('2026-03-05T09:31:00.000Z', `Thanks! ${'y'.repeat(200)}`, { speaker: 'mika' }),
    ];
    const label = renderSceneLabel(assistantFirst);
    expect(label.startsWith('Thanks!')).toBe(true);
    expect(label).toHaveLength(80);
    // All-assistant scene falls back to its first turn.
    expect(renderSceneLabel([assistantFirst[0]!])).toBe('Here is your daily summary');
  });
});

describe('scoreSceneDeterministic', () => {
  it('novelty = 1 − max cosine to prior centroids; absent without embeddings', () => {
    const turns = [at('2026-01-01T10:00:00.000Z', 'hello world')];
    const scored = scoreSceneDeterministic(
      [0, 1],
      [
        [1, 0],
        [0, 1],
      ],
      turns,
    );
    expect(scored.novelty).toBeCloseTo(0, 5); // identical prior exists
    const novel = scoreSceneDeterministic([0, 1], [[1, 0]], turns);
    expect(novel.novelty).toBeCloseTo(1, 5); // orthogonal to every prior
    const firstScene = scoreSceneDeterministic([0, 1], [], turns);
    expect(firstScene.novelty).toBeCloseTo(1, 5); // no priors = maximally novel
    expect(scoreSceneDeterministic(undefined, [], turns).novelty).toBeUndefined();
  });

  it('explicitness = fraction of first-person-declarative turns (en + ru)', () => {
    const turns = [
      at('2026-01-01T10:00:00.000Z', 'I moved to Lisbon'),
      at('2026-01-01T10:01:00.000Z', 'я люблю кофе'),
      at('2026-01-01T10:02:00.000Z', 'the weather held up'),
      at('2026-01-01T10:03:00.000Z', 'sounds great'),
    ];
    expect(scoreSceneDeterministic(undefined, [], turns).explicitness).toBeCloseTo(0.5, 5);
  });

  it('stamps version + scoredAt and leaves unscored dims undefined', () => {
    const scored = scoreSceneDeterministic(undefined, [], [at('2026-01-01T10:00:00.000Z', 'hi')]);
    expect(scored.scorerVersion).toBe(SCENE_SCORER_VERSION);
    expect(scored.scoredAt).toBeInstanceOf(Date);
    expect(scored.contradiction).toBeUndefined();
    expect(scored.stateChange).toBeUndefined();
    expect(scored.identity).toBeUndefined();
    expect(scored.estimatedUtility).toBeUndefined();
  });

  it('meanVector averages element-wise', () => {
    expect(
      meanVector([
        [1, 0],
        [0, 1],
      ]),
    ).toEqual([0.5, 0.5]);
    expect(meanVector([])).toEqual([]);
  });
});

describe('sceneConfigFingerprint / effectiveSegmenterVersion (Drift-3)', () => {
  const base: SceneSegmenterConfig = {
    topicBoundary: false,
    minCosine: 0.55,
    maxTurns: 40,
    embeddingSpaceId: null,
  };
  const boundaryOn: SceneSegmenterConfig = {
    ...base,
    topicBoundary: true,
    embeddingSpaceId: 'openai:text-embedding-3-small:1536:l2',
  };

  it('formats as scene-segmenter-v1+<8hex> and is deterministic', () => {
    const version = effectiveSegmenterVersion(base);
    expect(version).toMatch(/^scene-segmenter-v1\+[0-9a-f]{8}$/);
    expect(effectiveSegmenterVersion({ ...base })).toBe(version);
    expect(sceneConfigFingerprint({ ...base })).toBe(sceneConfigFingerprint(base));
  });

  it('every effective knob forks the fingerprint', () => {
    // topicBoundary flip forks.
    expect(sceneConfigFingerprint(boundaryOn)).not.toBe(sceneConfigFingerprint(base));
    // maxTurns change forks.
    expect(sceneConfigFingerprint({ ...base, maxTurns: 20 })).not.toBe(
      sceneConfigFingerprint(base),
    );
    // With the boundary ON, minCosine and the embedding space each fork.
    expect(sceneConfigFingerprint({ ...boundaryOn, minCosine: 0.7 })).not.toBe(
      sceneConfigFingerprint(boundaryOn),
    );
    expect(
      sceneConfigFingerprint({ ...boundaryOn, embeddingSpaceId: 'local:bge-m3:1024:l2' }),
    ).not.toBe(sceneConfigFingerprint(boundaryOn));
  });

  it('excludes knobs that cannot affect output when the boundary is off', () => {
    expect(sceneConfigFingerprint({ ...base, minCosine: 0.9 })).toBe(sceneConfigFingerprint(base));
    expect(sceneConfigFingerprint({ ...base, embeddingSpaceId: 'any:space:1:l2' })).toBe(
      sceneConfigFingerprint(base),
    );
  });
});

describe('foldSceneScope (segment-composer :147-160 rule)', () => {
  it('single-user scene: userId stamped, pii unioned', () => {
    const fold = foldSceneScope([
      at('2026-01-01T10:00:00.000Z', 'a', { userId: 'u1', piiClass: ['email'] }),
      at('2026-01-01T10:01:00.000Z', 'b', { userId: 'u1', piiClass: ['phone', 'email'] }),
    ]);
    expect(fold.userId).toBe('u1');
    expect(fold.piiClass).toEqual(['email', 'phone']);
  });

  it('mixed-user scene stays tenant-global; clean scene has no pii', () => {
    const fold = foldSceneScope([
      at('2026-01-01T10:00:00.000Z', 'a', { userId: 'u1' }),
      at('2026-01-01T10:01:00.000Z', 'b', { userId: 'u2' }),
    ]);
    expect(fold.userId).toBeUndefined();
    expect(fold.userIds).toEqual(['u1', 'u2']);
    expect(fold.piiClass).toBeUndefined();
  });

  it('userIds is SORTED regardless of turn order (0117 persisted determinism)', () => {
    const fold = foldSceneScope([
      at('2026-01-01T10:00:00.000Z', 'a', { userId: 'u2' }),
      at('2026-01-01T10:01:00.000Z', 'b', { userId: 'u1' }),
      at('2026-01-01T10:02:00.000Z', 'c', { userId: 'u2' }),
    ]);
    expect(fold.userIds).toEqual(['u1', 'u2']);
  });

  it('all-global scene folds to userIds [] (the "purely global" stamp, not NONE)', () => {
    expect(foldSceneScope([at('2026-01-01T10:00:00.000Z', 'a')]).userIds).toEqual([]);
  });
});
