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
  ENUMERATION_LANE_INSTRUCTION,
} from '../src/synthesize/answer-router';
import {
  buildGeneratorUserMessage,
  buildFactIndex,
  detectEvidenceConflicts,
} from '../src/synthesize/synthesize.service';
import { CONTRADICTION_NOTE_INSTRUCTION } from '../src/synthesize/answer-router';
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
  const unrouted = [
    'When did I visit the museum?', // plain when → legacy date-context path
    'What did I buy for my sister?',
    'How long is the Golden Gate Bridge?',
    'Where do I take yoga classes these days?',
  ];
  it.each(temporal)('routes: %s', (q) => {
    expect(detectLane(q)).toBe('temporal');
  });
  it.each(unrouted)('does not route: %s', (q) => {
    expect(detectLane(q)).toBeNull();
  });
});

describe('detectLane (enumeration lexicon + T1/T2 disambiguation)', () => {
  const enumeration = [
    'How many plants did I acquire in the last month?',
    'How many days did I spend on camping trips this year?', // duration SUM
    'How much total money have I spent on bike-related expenses?',
    'Can you list the order in which I brought up different aspects?',
    'Walk me through the order in which I raised topics.',
    'What are all the books I mentioned?',
    'How many model kits have I worked on or bought?',
  ];
  it.each(enumeration)('routes to enumeration: %s', (q) => {
    expect(detectLane(q)).toBe('enumeration');
  });
  it('temporal-distance still wins over bare counting', () => {
    // interval markers → temporal even though "how many" is present
    expect(detectLane('How many weeks ago did I attend the sale?')).toBe(
      'temporal',
    );
    expect(
      detectLane('How many months have passed since the concert?'),
    ).toBe('temporal');
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
  it('enumeration lane appends list-first discipline without a date anchor', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      query: 'How many model kits have I worked on?',
      lane: 'enumeration',
    });
    expect(msg).toContain(ENUMERATION_LANE_INSTRUCTION.trim());
    expect(msg).not.toContain('Today:');
  });
  it('no lane → byte-identical to the historical format', () => {
    const withLaneNull = buildGeneratorUserMessage({ ...base, lane: null });
    const withoutLane = buildGeneratorUserMessage(base);
    expect(withLaneNull).toBe(withoutLane);
    expect(withoutLane).not.toContain('temporal-distance');
    expect(withoutLane).not.toContain('enumeration/counting');
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

describe('detectEvidenceConflicts (T3)', () => {
  const hitWith = (facts: Array<Record<string, unknown>>) =>
    ({
      entityId: 'e1',
      entityType: 'person',
      canonicalName: 'n',
      externalRefs: {},
      score: 1,
      facts: facts.map((f, i) => ({
        factId: `knowledge_fact:f${i}`,
        confidence: 0.7,
        score: 1,
        ...f,
      })),
    }) as unknown as SearchHit;

  it('flags disagreeing objects when the write side marked COMPETING', () => {
    const conflicts = detectEvidenceConflicts([
      hitWith([
        { predicate: 'has_api_key', object: 'yes, for OpenWeather', status: 'active' },
        { predicate: 'has_api_key', object: 'no, never obtained one', status: 'COMPETING' },
      ]),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].label).toBe('has_api_key');
    expect(conflicts[0].factIds).toEqual([
      'knowledge_fact:f0',
      'knowledge_fact:f1',
    ]);
  });
  it('ignores ordinary multi-value slots without COMPETING status', () => {
    expect(
      detectEvidenceConflicts([
        hitWith([
          { predicate: 'works_at', object: 'Baseline Robotics', status: 'active' },
          { predicate: 'works_at', object: 'Hyphae Labs', status: 'active' },
        ]),
      ]),
    ).toEqual([]);
  });
  it('flags polarity splits in derived worlds (no COMPETING status)', () => {
    // Window-deriver worlds bypass the conflict predictor — both sides
    // land 'active'. Never/always-shaped contradictions split polarity.
    const conflicts = detectEvidenceConflicts([
      hitWith([
        { predicate: 'work', object: 'has never written any Flask routes', status: 'active' },
        { predicate: 'work', object: 'implemented a basic homepage route with Flask', status: 'active' },
      ]),
    ]);
    expect(conflicts).toHaveLength(1);
  });
  it('two affirmative objects share polarity — no conflict', () => {
    expect(
      detectEvidenceConflicts([
        hitWith([
          { predicate: 'activities', object: 'went hiking in Utah', status: 'active' },
          { predicate: 'activities', object: 'tried pottery classes', status: 'active' },
        ]),
      ]),
    ).toEqual([]);
  });
  it('ignores COMPETING duplicates that agree on the object', () => {
    expect(
      detectEvidenceConflicts([
        hitWith([
          { predicate: 'pet', object: 'cat Brioche', status: 'COMPETING' },
          { predicate: 'pet', object: 'cat Brioche', status: 'active' },
        ]),
      ]),
    ).toEqual([]);
  });

  it('renders the conflict section with the override instruction', () => {
    const msg = buildGeneratorUserMessage({
      query: 'Have I obtained an API key?',
      factLines: ['[knowledge_fact:f0] …'],
      answerLang: null,
      conflicts: [
        { factIds: ['knowledge_fact:f0', 'knowledge_fact:f1'], label: 'has_api_key' },
      ],
    });
    expect(msg).toContain('Conflict pairs');
    expect(msg).toContain('has_api_key: knowledge_fact:f0 vs knowledge_fact:f1');
    expect(msg).toContain(CONTRADICTION_NOTE_INSTRUCTION.trim());
  });
  it('empty conflicts → byte-identical to legacy', () => {
    const base = {
      query: 'q',
      factLines: ['[knowledge_fact:f0] …'],
      answerLang: null as string | null,
    };
    expect(buildGeneratorUserMessage({ ...base, conflicts: [] })).toBe(
      buildGeneratorUserMessage(base),
    );
  });
});

describe('buildFactIndex chronological ordering (T2)', () => {
  const mk = (id: string, validFrom?: string) =>
    ({
      entityId: 'e1',
      entityType: 'person',
      canonicalName: 'n',
      externalRefs: {},
      score: 1,
      facts: [
        {
          factId: `knowledge_fact:${id}`,
          predicate: 'did',
          object: id,
          confidence: 0.7,
          score: 1,
          ...(validFrom ? { validFrom } : {}),
        },
      ],
    }) as unknown as SearchHit;

  it('sorts dated facts ascending, undated last, stable', () => {
    const hits = [
      mk('later', '2023-05-01T00:00:00.000Z'),
      mk('undated1'),
      mk('earlier', '2023-01-15T00:00:00.000Z'),
      mk('undated2'),
    ];
    const { factLines } = buildFactIndex(hits, { chronological: true });
    const order = factLines.map((l) => /knowledge_fact:(\w+)/.exec(l)![1]);
    expect(order).toEqual(['earlier', 'later', 'undated1', 'undated2']);
  });
  it('without the flag retrieval order is preserved byte-identically', () => {
    const hits = [mk('b', '2023-05-01T00:00:00.000Z'), mk('a', '2023-01-15T00:00:00.000Z')];
    const { factLines } = buildFactIndex(hits);
    expect(factLines[0]).toContain(':b');
    expect(factLines[1]).toContain(':a');
  });
});
