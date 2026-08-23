import {
  buildDeriverSystem,
  COMPOSE_SYSTEM,
  DERIVER_SCENE_SECTION,
  DERIVER_TURN_TIME_SECTION,
} from './deriver-client';
import { formatTurnStamp } from './window-deriver.service';
import { scoreRows } from '../search/internals/scoring';

describe('DERIVER_TURN_HEADERS (V13 event-time grounding)', () => {
  it('system prompt gains the turn-timestamp section only under the flag', () => {
    expect(buildDeriverSystem({ turnHeaders: true })).toContain('TURN TIMESTAMPS');
    expect(buildDeriverSystem({})).not.toContain('TURN TIMESTAMPS');
    expect(buildDeriverSystem()).toBe(buildDeriverSystem({ turnHeaders: false }));
  });

  it('keeps the same-day session-date convention in the section (armK guard)', () => {
    expect(DERIVER_TURN_TIME_SECTION).toMatch(/this rule is unchanged/);
  });

  it('scene section is flag-gated and bans generic traces', () => {
    expect(buildDeriverSystem({ sceneTrace: true })).toContain('SCENE TRACES');
    expect(buildDeriverSystem({})).not.toContain('SCENE TRACES');
    expect(DERIVER_SCENE_SECTION).toMatch(/"during the conversation" is always wrong/);
  });

  it('compose pass demands multi-atom support and allows empty output', () => {
    expect(COMPOSE_SYSTEM).toMatch(/two or more atoms/);
    expect(COMPOSE_SYSTEM).toMatch(/empty list is the correct output/);
    expect(COMPOSE_SYSTEM).toMatch(/never bridge with outside knowledge/);
  });

  it('formats turn stamps as YYYY-MM-DD HH:MM (UTC)', () => {
    expect(formatTurnStamp('2023-05-07T14:30:45.000Z')).toBe('2023-05-07 14:30');
    expect(formatTurnStamp('not-a-date!')).toBe('not-a-date!');
  });
});

describe('scoreRows queryRange factor (V13 RETRIEVAL_TIME_FILTER)', () => {
  const row = (validFrom: string) =>
    ({
      entityId: 'entity:a',
      predicate: 'events',
      object: 'x',
      confidence: 0.9,
      fusedScore: 1,
      recordedAt: '2023-05-01T00:00:00.000Z',
      validFrom,
      source: {},
    }) as unknown as Parameters<typeof scoreRows>[0]['rows'][number];

  const now = Date.parse('2023-06-01T00:00:00.000Z');
  const range = {
    fromMs: Date.UTC(2023, 4, 1),
    toMs: Date.UTC(2023, 5, 1),
  };

  it('demotes out-of-period facts and leaves in-period facts intact', () => {
    const scoredPair = scoreRows({
      rows: [row('2023-05-04T00:00:00.000Z'), row('2022-11-04T00:00:00.000Z')],
      now,
      queryRange: range,
    });
    const inRange = scoredPair[0]!;
    const outOfRange = scoredPair[1]!;
    expect(inRange.score).toBeGreaterThan(outOfRange.score);
    expect(inRange.breakdown.timeRange).toBeUndefined();
    expect(outOfRange.breakdown.timeRange).toBeLessThan(1);
    expect(outOfRange.breakdown.timeRange).toBeGreaterThanOrEqual(0.25);
  });

  it('is byte-identical with no range', () => {
    const a = scoreRows({ rows: [row('2022-11-04T00:00:00.000Z')], now })[0]!;
    expect(a.breakdown.timeRange).toBeUndefined();
  });

  it('an in-period mention anchor rescues an out-of-period validity', () => {
    const r = row('2022-11-04T00:00:00.000Z');
    (r as { source: Record<string, unknown> }).source = {
      mentionedAt: '2023-05-10T00:00:00.000Z',
    };
    const scored = scoreRows({ rows: [r], now, queryRange: range })[0]!;
    expect(scored.breakdown.timeRange).toBeUndefined();
  });
});
