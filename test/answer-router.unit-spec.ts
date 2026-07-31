/**
 * T1 typed dispatch (docs/roadmap/typed-answer-dispatch-2026-07.md):
 * pins the lexical temporal-lane router, the calendar-aware elapsed
 * arithmetic (the non-LLM core of the lane), the lane's prompt frame,
 * and — critically — byte-identity of the legacy path when the lane is
 * not routed (fail-open contract).
 */
import {
  detectLane,
  formatElapsed,
  TEMPORAL_LANE_INSTRUCTION,
} from '../src/synthesize/answer-router';
import {
  buildGeneratorUserMessage,
  buildFactIndex,
} from '../src/synthesize/synthesize.service';
import type { SearchHit } from '../src/search/search.types';

describe('detectLane (temporal lexicon)', () => {
  const temporal = [
    'How many weeks ago did I attend the friends and family sale?',
    'How many months have passed since I last visited a museum?',
    'How many days passed between the two concerts?',
    'How long ago did we adopt Luna?',
    'How long has it been since my last dentist visit?',
    'how many years since graduation?',
  ];
  const notTemporal = [
    'When did I visit the museum?', // plain when → legacy date-context path
    'What did I buy for my sister?',
    'How many plants did I acquire?', // counting, not temporal distance
    'How long is the Golden Gate Bridge?',
    'Where do I take yoga classes these days?',
  ];
  it.each(temporal)('routes: %s', (q) => {
    expect(detectLane(q)).toBe('temporal');
  });
  it.each(notTemporal)('does not route: %s', (q) => {
    expect(detectLane(q)).toBeNull();
  });
});

describe('formatElapsed (calendar arithmetic in code)', () => {
  const asOf = '2023-02-27T00:00:00.000Z';
  it('renders days/weeks/calendar months', () => {
    // 2022-10-22 → 2023-02-27: 128 days, 18 weeks, 4 calendar months
    expect(formatElapsed('2022-10-22T00:00:00.000Z', asOf)).toBe(
      ' [elapsed: 128 days ≈ 18 weeks ≈ 4 months before today]',
    );
  });
  it('month decrements when the day has not been reached', () => {
    // 2023-01-30 → 2023-02-27: 28 days, 4 weeks, 0 full calendar months
    expect(formatElapsed('2023-01-30T00:00:00.000Z', asOf)).toBe(
      ' [elapsed: 28 days ≈ 4 weeks before today]',
    );
  });
  it('handles sub-week and singular units', () => {
    expect(formatElapsed('2023-02-26T00:00:00.000Z', asOf)).toBe(
      ' [elapsed: 1 day before today]',
    );
  });
  it('annotates future dates and skips unparseable/epoch', () => {
    expect(formatElapsed('2023-03-04T00:00:00.000Z', asOf)).toBe(
      ' [elapsed: in 5 days]',
    );
    expect(formatElapsed(undefined, asOf)).toBe('');
    expect(formatElapsed('not-a-date', asOf)).toBe('');
    expect(formatElapsed(new Date(0).toISOString(), asOf)).toBe('');
  });
});

describe('lane prompt assembly', () => {
  const base = {
    query: 'How many weeks ago did I attend the sale?',
    factLines: ['[knowledge_fact:x] u — attended: sale (as of 2022-11-17)'],
    answerLang: null as string | null,
  };
  it('temporal lane appends the compute-then-answer instruction', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      dateContext: '2022-12-01',
      lane: 'temporal',
    });
    expect(msg).toContain('Today: 2022-12-01');
    expect(msg).toContain(TEMPORAL_LANE_INSTRUCTION.trim());
  });
  it('no lane → byte-identical to the historical format', () => {
    const withLaneNull = buildGeneratorUserMessage({ ...base, lane: null });
    const withoutLane = buildGeneratorUserMessage(base);
    expect(withLaneNull).toBe(withoutLane);
    expect(withoutLane).not.toContain('temporal-distance');
  });
});

describe('buildFactIndex elapsed annotations', () => {
  const hit = {
    entityId: 'e1',
    entityType: 'person',
    canonicalName: 'nadia',
    externalRefs: {},
    score: 1,
    facts: [
      {
        factId: 'knowledge_fact:aaa',
        predicate: 'attended',
        object: 'Nordstrom sale',
        confidence: 0.7,
        score: 1,
        validFrom: '2022-11-17T00:00:00.000Z',
      },
      {
        factId: 'knowledge_fact:bbb',
        predicate: 'likes',
        object: 'jazz',
        confidence: 0.7,
        score: 1,
      },
    ],
  } as unknown as SearchHit;

  it('annotates dated facts when elapsedAsOf is set; undated untouched', () => {
    const { factLines } = buildFactIndex([hit], {
      elapsedAsOf: '2022-12-01T00:00:00.000Z',
    });
    expect(factLines[0]).toContain('[elapsed: 14 days ≈ 2 weeks before today]');
    expect(factLines[1]).not.toContain('elapsed');
  });
  it('without elapsedAsOf output is byte-identical to legacy', () => {
    const a = buildFactIndex([hit]).factLines;
    const b = buildFactIndex([hit], {}).factLines;
    expect(a).toEqual(b);
    expect(a[0]).not.toContain('elapsed');
  });
});
