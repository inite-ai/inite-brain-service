/**
 * T1 typed dispatch (docs/roadmap/typed-answer-dispatch-2026-07.md):
 * pins the lexical temporal-lane router, the calendar-aware elapsed
 * arithmetic (the non-LLM core of the lane), the lane's prompt frame,
 * and — critically — byte-identity of the legacy path when the lane is
 * not routed (fail-open contract).
 */
import {
  detectLane,
  routeLane,
  laneEnabled,
  detectOrderingShape,
  orderingFirstMentionEnabled,
  temporalIntervalsEnabled,
  buildIntervalTable,
  wideLaneProbeEnabled,
  wideProbeLimit,
  buildWideProbeQuery,
  instructionLaneEnabled,
  extractStandingInstructions,
  STANDING_INSTRUCTIONS_INSTRUCTION,
  formatElapsed,
  TEMPORAL_LANE_INSTRUCTION,
  TEMPORAL_INTERVAL_INSTRUCTION,
  ENUMERATION_LANE_INSTRUCTION,
  ORDERING_LANE_INSTRUCTION,
} from '../src/synthesize/answer-router';
import { parseDisabledLanes } from '../src/synthesize/lanes-disabled';
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

describe('detectLane (preference and summary lexicons)', () => {
  it.each([
    'Can you recommend some interesting cultural events this week?',
    'Can you suggest a hotel for my upcoming trip to Miami?',
    'Any recommendations for evening activities?',
    'What should I read next?',
  ])('routes to preference: %s', (q) => {
    expect(detectLane(q)).toBe('preference');
  });
  it.each([
    'Can you give me a comprehensive summary of how I handled security?',
    'How has my weather app project progressed over time?',
    'Give me an overview of my portfolio website work.',
    'Summarize my budget tracker journey.',
  ])('routes to summary: %s', (q) => {
    expect(detectLane(q)).toBe('summary');
  });
});

describe('SYNTHESIZE_LANES_DISABLED (per-lane ablation)', () => {
  beforeEach(() => {
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    delete process.env.SYNTHESIZE_LANES_DISABLED;
  });

  it('parses tokens, aliases and rejects unknowns', () => {
    expect(parseDisabledLanes('t3,t5')).toEqual({
      lanes: new Set(['contradiction', 'recency']),
      unknown: [],
    });
    expect(parseDisabledLanes(' Temporal , SUMMARY ')).toEqual({
      lanes: new Set(['temporal', 'summary']),
      unknown: [],
    });
    expect(parseDisabledLanes('t1,t9,recensy')).toEqual({
      lanes: new Set(['temporal']),
      unknown: ['t9', 'recensy'],
    });
    expect(parseDisabledLanes(undefined)).toEqual({
      lanes: new Set(),
      unknown: [],
    });
  });

  it('a disabled lane behaves as if never built (falls to legacy path)', () => {
    process.env.SYNTHESIZE_LANES_DISABLED = 't1';
    expect(routeLane('How many weeks ago did I attend the sale?')).toBeNull();
    // other lanes stay live in the same process env
    expect(routeLane('What are all the books I mentioned?')).toBe(
      'enumeration',
    );
  });

  it('disabling one lane lets the query fall through to later lexicons', () => {
    // "list the order" matches enumeration; with t2 off the same query
    // must not resurface via another lane (lexicons are disjoint).
    process.env.SYNTHESIZE_LANES_DISABLED = 't2';
    expect(
      routeLane('Can you list the order in which I brought up aspects?'),
    ).toBeNull();
  });

  it('laneEnabled composes router flag AND per-lane ablation', () => {
    expect(laneEnabled('recency')).toBe(true);
    process.env.SYNTHESIZE_LANES_DISABLED = 't5';
    expect(laneEnabled('recency')).toBe(false);
    expect(laneEnabled('contradiction')).toBe(true);
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    expect(laneEnabled('contradiction')).toBe(false);
  });

  it('t3 disable silences detectEvidenceConflicts with the router on', () => {
    const hits = [
      {
        entityId: 'e1',
        entityType: 'person',
        canonicalName: 'n',
        externalRefs: {},
        score: 1,
        facts: [
          {
            factId: 'knowledge_fact:f0',
            predicate: 'has_api_key',
            object: 'yes, for OpenWeather',
            status: 'active',
            confidence: 0.7,
            score: 1,
          },
          {
            factId: 'knowledge_fact:f1',
            predicate: 'has_api_key',
            object: 'no, never obtained one',
            status: 'COMPETING',
            confidence: 0.7,
            score: 1,
          },
        ],
      },
    ] as unknown as SearchHit[];
    expect(detectEvidenceConflicts(hits)).toHaveLength(1);
    process.env.SYNTHESIZE_LANES_DISABLED = 't3';
    expect(detectEvidenceConflicts(hits)).toEqual([]);
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
  // The detector is flag-gated internally (returns [] when the router
  // is off — that IS the fail-open contract); enable it for these tests.
  beforeAll(() => {
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
  });
  it('returns [] with the router flag off (fail-open)', () => {
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    expect(detectEvidenceConflicts([])).toEqual([]);
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
  });
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

describe('T1b event-interval table', () => {
  afterEach(() => {
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    delete process.env.SYNTHESIZE_TEMPORAL_EVENT_INTERVALS;
    delete process.env.SYNTHESIZE_LANES_DISABLED;
  });

  it('temporalIntervalsEnabled requires router + t1 + its own flag', () => {
    expect(temporalIntervalsEnabled()).toBe(false);
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    expect(temporalIntervalsEnabled()).toBe(false);
    process.env.SYNTHESIZE_TEMPORAL_EVENT_INTERVALS = '1';
    expect(temporalIntervalsEnabled()).toBe(true);
    process.env.SYNTHESIZE_LANES_DISABLED = 't1';
    expect(temporalIntervalsEnabled()).toBe(false);
  });

  const hitWithDates = (dates: Array<string | undefined>) =>
    ({
      entityId: 'e1',
      entityType: 'person',
      canonicalName: 'n',
      externalRefs: {},
      score: 1,
      facts: dates.map((d, i) => ({
        factId: `knowledge_fact:f${i}`,
        predicate: 'events',
        object: `event ${i}`,
        confidence: 0.7,
        score: 1,
        ...(d ? { validFrom: d } : {}),
      })),
    }) as unknown as SearchHit;

  it('renders every pair of distinct dates with calendar arithmetic', () => {
    const lines = buildIntervalTable([
      hitWithDates([
        '2024-01-15T00:00:00.000Z',
        '2024-03-15T00:00:00.000Z',
        '2024-01-15T09:30:00.000Z', // same DAY → not a new date
        undefined, // undated → ignored
      ]),
    ]);
    // 2 distinct dates → 1 pair; Jan 15 → Mar 15 2024 = 60 days
    expect(lines).toEqual([
      '2024-01-15 → 2024-03-15: 60 days ≈ 8 weeks ≈ 2 months',
    ]);
  });

  it('sorts dates ascending regardless of evidence order', () => {
    const lines = buildIntervalTable([
      hitWithDates([
        '2024-03-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
        '2024-02-01T00:00:00.000Z',
      ]),
    ]);
    expect(lines).toHaveLength(3); // C(3,2)
    expect(lines[0]).toBe('2024-01-01 → 2024-02-01: 31 days ≈ 4 weeks ≈ 1 month');
    expect(lines[2]).toBe('2024-02-01 → 2024-03-01: 29 days ≈ 4 weeks ≈ 1 month');
  });

  it('caps at 10 distinct dates by first-seen evidence order', () => {
    const dates = Array.from(
      { length: 14 },
      (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    );
    const lines = buildIntervalTable([hitWithDates(dates)]);
    expect(lines).toHaveLength(45); // C(10,2)
  });

  it('skips epoch-sentinel and unparseable dates; empty → []', () => {
    expect(
      buildIntervalTable([
        hitWithDates([new Date(0).toISOString(), 'not-a-date', undefined]),
      ]),
    ).toEqual([]);
  });

  it('interval section renders in the prompt; absent → byte-identical', () => {
    const base = {
      query: 'How many weeks between finishing X and the deadline?',
      factLines: ['[knowledge_fact:f0] n — events: e (as of 2024-01-15)'],
      answerLang: null as string | null,
      lane: 'temporal' as const,
    };
    const msg = buildGeneratorUserMessage({
      ...base,
      intervalTable: ['2024-01-15 → 2024-03-15: 60 days ≈ 8 weeks ≈ 2 months'],
    });
    expect(msg).toContain(TEMPORAL_INTERVAL_INSTRUCTION.trim());
    expect(msg).toContain('Date-interval table (computed):');
    expect(msg).toContain('2024-01-15 → 2024-03-15: 60 days');
    for (const table of [undefined, [] as string[]]) {
      expect(buildGeneratorUserMessage({ ...base, intervalTable: table })).toBe(
        buildGeneratorUserMessage(base),
      );
    }
  });
});

describe('T2b first-mention ordering', () => {
  afterEach(() => {
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    delete process.env.SYNTHESIZE_ORDERING_FIRST_MENTION;
  });

  it('detectOrderingShape matches the ordering subset only', () => {
    for (const q of [
      'Can you list the order in which I brought up different aspects, in order?',
      'In what order did I raise the topics?',
      'Walk me through the order in which I raised topics.',
      'Name the order of my project phases.',
    ]) {
      expect(detectOrderingShape(q)).toBe(true);
    }
    for (const q of [
      'How many plants did I acquire?',
      'What are all the books I mentioned?',
      'How many weeks ago did I attend the sale?',
    ]) {
      expect(detectOrderingShape(q)).toBe(false);
    }
  });

  it('orderingFirstMentionEnabled requires router + t2 + its own flag', () => {
    expect(orderingFirstMentionEnabled()).toBe(false);
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    expect(orderingFirstMentionEnabled()).toBe(false);
    process.env.SYNTHESIZE_ORDERING_FIRST_MENTION = '1';
    expect(orderingFirstMentionEnabled()).toBe(true);
    process.env.SYNTHESIZE_LANES_DISABLED = 't2';
    expect(orderingFirstMentionEnabled()).toBe(false);
    delete process.env.SYNTHESIZE_LANES_DISABLED;
  });

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
          predicate: 'work',
          object: id,
          confidence: 0.7,
          score: 1,
          ...(validFrom ? { validFrom } : {}),
        },
      ],
    }) as unknown as SearchHit;

  it('mention dates outrank validFrom as sort key and annotate lines', () => {
    // Event dates (validFrom) say core-func came SECOND; mention dates
    // say it was brought up FIRST — mention order must win.
    const hits = [
      mk('error_handling', '2024-01-10T00:00:00.000Z'),
      mk('core_functionality', '2024-02-01T00:00:00.000Z'),
    ];
    const { factLines } = buildFactIndex(hits, {
      chronological: true,
      mentionDates: {
        'knowledge_fact:error_handling': '2024-03-05T00:00:00.000Z',
        'knowledge_fact:core_functionality': '2024-03-01T00:00:00.000Z',
      },
    });
    const order = factLines.map((l) => /knowledge_fact:(\w+)/.exec(l)![1]);
    expect(order).toEqual(['core_functionality', 'error_handling']);
    expect(factLines[0]).toContain('[first mentioned: 2024-03-01]');
  });

  it('facts without a mention date fall back to validFrom, unannotated', () => {
    const hits = [
      mk('unmapped', '2024-01-05T00:00:00.000Z'),
      mk('mapped', '2024-04-01T00:00:00.000Z'),
    ];
    const { factLines } = buildFactIndex(hits, {
      chronological: true,
      mentionDates: { 'knowledge_fact:mapped': '2024-02-01T00:00:00.000Z' },
    });
    const order = factLines.map((l) => /knowledge_fact:(\w+)/.exec(l)![1]);
    expect(order).toEqual(['unmapped', 'mapped']);
    expect(factLines[0]).not.toContain('first mentioned');
  });

  it('without mentionDates output is byte-identical to legacy', () => {
    const hits = [mk('a', '2024-01-05T00:00:00.000Z')];
    expect(buildFactIndex(hits, {}).factLines).toEqual(
      buildFactIndex(hits, { mentionDates: undefined }).factLines,
    );
  });

  it('ordering frame replaces the enumeration instruction', () => {
    const base = {
      query: 'Can you list the order in which I brought up aspects?',
      factLines: ['[knowledge_fact:x] n — work: a (as of 2024-01-05)'],
      answerLang: null as string | null,
      lane: 'enumeration' as const,
    };
    const msg = buildGeneratorUserMessage({ ...base, ordering: true });
    expect(msg).toContain(ORDERING_LANE_INSTRUCTION.trim());
    expect(msg).not.toContain(ENUMERATION_LANE_INSTRUCTION.trim());
    // ordering flag off → plain enumeration frame, byte-identical
    expect(buildGeneratorUserMessage({ ...base, ordering: false })).toBe(
      buildGeneratorUserMessage(base),
    );
  });
});

describe('T6/T2 wide probe', () => {
  afterEach(() => {
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    delete process.env.SYNTHESIZE_LANE_WIDE_PROBE;
    delete process.env.SYNTHESIZE_WIDE_PROBE_LIMIT;
  });

  it('wideLaneProbeEnabled requires router + its own flag', () => {
    expect(wideLaneProbeEnabled()).toBe(false);
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    expect(wideLaneProbeEnabled()).toBe(false);
    process.env.SYNTHESIZE_LANE_WIDE_PROBE = '1';
    expect(wideLaneProbeEnabled()).toBe(true);
  });

  it('wideProbeLimit defaults to 12 and parses the env override', () => {
    expect(wideProbeLimit()).toBe(12);
    process.env.SYNTHESIZE_WIDE_PROBE_LIMIT = '20';
    expect(wideProbeLimit()).toBe(20);
    process.env.SYNTHESIZE_WIDE_PROBE_LIMIT = 'nope';
    expect(wideProbeLimit()).toBe(12);
  });

  it('buildWideProbeQuery appends top entities and dominant aspects', () => {
    const hit = (name: string, preds: string[]) =>
      ({
        entityId: `e_${name}`,
        entityType: 'person',
        canonicalName: name,
        externalRefs: {},
        score: 1,
        facts: preds.map((p, i) => ({
          factId: `knowledge_fact:${name}${i}`,
          predicate: p,
          object: 'x',
          confidence: 0.7,
          score: 1,
        })),
      }) as unknown as SearchHit;
    const q = buildWideProbeQuery('How has my tracker progressed?', [
      hit('mikhail__user', ['work', 'work', 'plans', 'events']),
      hit('assistant', ['work', 'media']),
      hit('third', ['health']),
    ]);
    // ≤2 entity names, ≤4 aspects by frequency (work=3 first)
    expect(q).toBe(
      'How has my tracker progressed? mikhail__user assistant work plans events media',
    );
  });

  it('empty base hits degrade to the bare query', () => {
    expect(buildWideProbeQuery('q', [])).toBe('q');
  });
});

describe('T7 instruction lane', () => {
  afterEach(() => {
    delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    delete process.env.SYNTHESIZE_INSTRUCTION_LANE;
    delete process.env.SYNTHESIZE_LANES_DISABLED;
  });

  it('instructionLaneEnabled requires router + flag, ablatable via t7', () => {
    expect(instructionLaneEnabled()).toBe(false);
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    process.env.SYNTHESIZE_INSTRUCTION_LANE = '1';
    expect(instructionLaneEnabled()).toBe(true);
    process.env.SYNTHESIZE_LANES_DISABLED = 't7';
    expect(instructionLaneEnabled()).toBe(false);
  });

  const hitWith = (facts: Array<[string, string]>) =>
    ({
      entityId: 'e1',
      entityType: 'person',
      canonicalName: 'u',
      externalRefs: {},
      score: 1,
      facts: facts.map(([predicate, object], i) => ({
        factId: `knowledge_fact:i${i}`,
        predicate,
        object,
        confidence: 0.7,
        score: 1,
      })),
    }) as unknown as SearchHit;

  it('keeps instruction-shaped preference facts, drops plain facts', () => {
    const out = extractStandingInstructions([
      hitWith([
        [
          'preferences',
          'u prefers to have all code snippets formatted with syntax highlighting when asking about implementation details.',
        ],
        // bare "never" on a non-preference aspect = plain fact, not an
        // instruction — the false-positive tier must exclude it
        ['work', 'u has never written any Flask routes in this project.'],
        ['activities', 'u went hiking in Utah.'],
        // strong trigger on a non-preference aspect still qualifies
        ['work', 'u asked to always include exact API version numbers.'],
      ]),
    ]);
    expect(out).toEqual([
      'u prefers to have all code snippets formatted with syntax highlighting when asking about implementation details.',
      'u asked to always include exact API version numbers.',
    ]);
  });

  it('dedups case-insensitively and honors the cap', () => {
    const dup =
      'u prefers bullet points whenever the user asks about planning.';
    const out = extractStandingInstructions(
      [hitWith([['preferences', dup], ['preferences', dup.toUpperCase()]])],
      1,
    );
    expect(out).toHaveLength(1);
  });

  it('renders the standing-instructions section; absent → byte-identical', () => {
    const base = {
      query: 'Could you show me how to implement a login feature?',
      factLines: ['[knowledge_fact:x] u — work: builds a Flask app'],
      answerLang: null as string | null,
    };
    const msg = buildGeneratorUserMessage({
      ...base,
      instructions: ['always format code with syntax highlighting'],
    });
    expect(msg).toContain(STANDING_INSTRUCTIONS_INSTRUCTION.trim());
    expect(msg).toContain('- always format code with syntax highlighting');
    for (const instructions of [undefined, [] as string[]]) {
      expect(buildGeneratorUserMessage({ ...base, instructions })).toBe(
        buildGeneratorUserMessage(base),
      );
    }
  });
});

describe('buildFactIndex recency marker (T5)', () => {
  const slotHit = (facts: Array<[string, string, string?]>) =>
    ({
      entityId: 'e1',
      entityType: 'person',
      canonicalName: 'n',
      externalRefs: {},
      score: 1,
      facts: facts.map(([id, object, validFrom]) => ({
        factId: `knowledge_fact:${id}`,
        predicate: 'coverage',
        object,
        confidence: 0.7,
        score: 1,
        ...(validFrom ? { validFrom } : {}),
      })),
    }) as unknown as SearchHit;

  it('tags max(validFrom) on disagreeing dated slots', () => {
    const { factLines } = buildFactIndex(
      [
        slotHit([
          ['old', '65%', '2024-03-20T00:00:00.000Z'],
          ['new', '78%', '2024-04-18T00:00:00.000Z'],
        ]),
      ],
      { markRecency: true },
    );
    expect(factLines.find((l) => l.includes(':new'))).toContain(
      '[most recent for this slot]',
    );
    expect(factLines.find((l) => l.includes(':old'))).not.toContain(
      'most recent',
    );
  });
  it('never tags agreeing or single-dated slots', () => {
    const { factLines } = buildFactIndex(
      [
        slotHit([
          ['a', 'same value', '2024-03-20T00:00:00.000Z'],
          ['b', 'same value', '2024-04-18T00:00:00.000Z'],
        ]),
      ],
      { markRecency: true },
    );
    expect(factLines.join('\n')).not.toContain('most recent');
  });
});
