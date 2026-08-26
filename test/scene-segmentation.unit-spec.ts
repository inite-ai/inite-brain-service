/**
 * Pure-function tests for the Brain v2 scene segmenter
 * (src/admin/scene-segmentation.ts): boundary detection (session gap via
 * the shared segmentSessions, cosine topic split, min scene size,
 * max-turns force split, determinism), the deterministic gist/label
 * renders, the deterministic memory-value scorer, and the scope/PII fold
 * (segment-composer :147-160 rule).
 */
import {
  detectSceneBoundaries,
  foldSceneScope,
  meanVector,
  renderSceneGist,
  renderSceneLabel,
  scoreSceneDeterministic,
  SCENE_SCORER_VERSION,
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
});
