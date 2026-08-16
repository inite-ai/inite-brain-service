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
  laneProbeDto,
  buildWideProbeQuery,
  extractStandingInstructions,
  STANDING_INSTRUCTIONS_INSTRUCTION,
  formatElapsed,
  detectVerbatimShape,
  TEMPORAL_LANE_INSTRUCTION,
  ENUMERATION_LANE_INSTRUCTION,
  LANE_REGISTRY,
} from '../src/synthesize/answer-router';
import {
  resolveRetrievalProfile,
  ALL_LANES,
  type RetrievalProfile,
} from '../src/search/retrieval-profile';

/** Profile with every lane live (router-on shape) + overridable knobs. */
function profileWith(over: Partial<RetrievalProfile> = {}): RetrievalProfile {
  return {
    ...resolveRetrievalProfile({} as NodeJS.ProcessEnv),
    lanes: new Set(ALL_LANES),
    ...over,
  };
}
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

describe('LME-500 gap lexicon (first-person perfect + "order of")', () => {
  const temporalV2 = [
    'How long had I been watching stand-up comedy specials regularly when I attended the open mic night?',
    'How long have I been taking sculpting classes?',
  ];
  const enumerationV2 = [
    'What is the order of the six museums I visited from earliest to latest?',
    'What was the order of the concerts I attended in the past two months?',
  ];
  it('first-person perfect routes temporal, "order of" routes enumeration', () => {
    for (const q of temporalV2) expect(detectLane(q)).toBe('temporal');
    for (const q of enumerationV2) expect(detectLane(q)).toBe('enumeration');
  });
});

describe('verbatim-recall shape (engine default)', () => {
  it.each([
    'What did you suggest I use for rate limiting?',
    'What was your recommendation for the database schema?',
    'What were the steps you walked me through for the deploy?',
    'Can you repeat word for word what the error message meant?',
    'What did the assistant say about my visa options?',
    'You told me a trick for CSS centering — what was it?',
  ])('detects assistant-content recall: %s', (q) => {
    expect(detectVerbatimShape(q)).toBe(true);
  });
  it.each([
    'How long have I been taking sculpting classes?',
    'Can you recommend some interesting cultural events this week?',
    'How many model kits did I buy?',
    'Summarize my budget tracker journey.',
    'What is my favorite restaurant?',
  ])('stays quiet on non-verbatim questions: %s', (q) => {
    expect(detectVerbatimShape(q)).toBe(false);
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
  // The detector is lane-gated: without the contradiction lane in the
  // profile's set it returns [] — that IS the fail-open contract.
  const LANES = new Set(ALL_LANES);
  it('returns [] when the contradiction lane is not live (fail-open)', () => {
    expect(detectEvidenceConflicts([], new Set())).toEqual([]);
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
    ], LANES);
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
      ], LANES),
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
    ], LANES);
    expect(conflicts).toHaveLength(1);
  });
  it('two affirmative objects share polarity — no conflict', () => {
    expect(
      detectEvidenceConflicts([
        hitWith([
          { predicate: 'activities', object: 'went hiking in Utah', status: 'active' },
          { predicate: 'activities', object: 'tried pottery classes', status: 'active' },
        ]),
      ], LANES),
    ).toEqual([]);
  });
  it('ignores COMPETING duplicates that agree on the object', () => {
    expect(
      detectEvidenceConflicts([
        hitWith([
          { predicate: 'pet', object: 'cat Brioche', status: 'COMPETING' },
          { predicate: 'pet', object: 'cat Brioche', status: 'active' },
        ]),
      ], LANES),
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

describe('T6/T2 wide probe (profile-driven)', () => {
  it('probes nothing when the profile has wideProbe off', () => {
    expect(
      laneProbeDto(profileWith({ wideProbe: false }), 'summary', {
        query: 'q',
        baseHits: [],
      }),
    ).toBeNull();
  });

  it('probes the PRF query with the profile limit when on', () => {
    const dto = laneProbeDto(
      profileWith({ wideProbe: true, wideProbeLimit: 20 }),
      'summary',
      { query: 'How has my tracker progressed?', baseHits: [] },
    );
    expect(dto).toEqual({
      query: 'How has my tracker progressed?',
      limit: 20,
    });
  });

  it('preference lane probes the fixed tastes query regardless', () => {
    const dto = laneProbeDto(profileWith(), 'preference', {
      query: 'q',
      baseHits: [],
    });
    expect(dto?.limit).toBe(8);
    expect(dto?.query).toContain('preferences');
  });

  it('a lane outside the profile set probes nothing', () => {
    expect(
      laneProbeDto(profileWith({ lanes: new Set(['temporal']) }), 'preference', {
        query: 'q',
        baseHits: [],
      }),
    ).toBeNull();
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

describe('routeLane respects the profile lane set', () => {
  it('routes only lanes present in the set', () => {
    const q = 'How many weeks ago did I attend the sale?';
    expect(routeLane(profileWith(), q)).toBe('temporal');
    expect(routeLane(profileWith({ lanes: new Set() }), q)).toBeNull();
    expect(
      routeLane(profileWith({ lanes: new Set(['enumeration']) }), q),
    ).toBeNull();
  });
});

describe('lane registry completeness', () => {
  it('every LaneId has exactly one registry entry', () => {
    const ids = LANE_REGISTRY.map((l) => l.id);
    expect([...ids].sort()).toEqual([...ALL_LANES].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('T7 instruction lane', () => {
  it('joins the default profile lane set only via the boot env keys', () => {
    const off = resolveRetrievalProfile({} as NodeJS.ProcessEnv);
    expect(off.lanes.size).toBe(0);
    const routerOnly = resolveRetrievalProfile({
      SYNTHESIZE_ANSWER_ROUTER_ENABLED: '1',
    } as NodeJS.ProcessEnv);
    expect(routerOnly.lanes.has('temporal')).toBe(true);
    expect(routerOnly.lanes.has('instruction')).toBe(false);
    const withInstruction = resolveRetrievalProfile({
      SYNTHESIZE_ANSWER_ROUTER_ENABLED: '1',
      SYNTHESIZE_INSTRUCTION_LANE: '1',
    } as NodeJS.ProcessEnv);
    expect(withInstruction.lanes.has('instruction')).toBe(true);
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


describe('buildFactIndex mention-date suffix (V12 §1 read side)', () => {
  const mkHit = (facts: Array<Record<string, unknown>>) =>
    ({
      entityId: 'e1',
      entityType: 'person',
      canonicalName: 'nadia',
      externalRefs: {},
      score: 1,
      facts,
    }) as unknown as SearchHit;

  const fact = (over: Record<string, unknown>) => ({
    factId: 'knowledge_fact:m1',
    predicate: 'went_to',
    object: 'a pottery class',
    confidence: 0.7,
    score: 1,
    ...over,
  });

  it('renders the anchor when it disagrees with validFrom by day', () => {
    const { factLines } = buildFactIndex(
      [
        mkHit([
          fact({
            validFrom: '2023-05-06T00:00:00.000Z',
            mentionedAt: '2023-05-08T15:56:00.000Z',
          }),
        ]),
      ],
      { mentionDates: true },
    );
    expect(factLines[0]).toContain('(as of 2023-05-06)');
    expect(factLines[0]).toContain('(mentioned 2023-05-08)');
  });

  it('same-day anchors render nothing extra', () => {
    const { factLines } = buildFactIndex(
      [
        mkHit([
          fact({
            validFrom: '2023-05-06T00:00:00.000Z',
            mentionedAt: '2023-05-06T15:56:00.000Z',
          }),
        ]),
      ],
      { mentionDates: true },
    );
    expect(factLines[0]).not.toContain('mentioned');
  });

  it('unstamped facts and disabled flag render the historical format', () => {
    const stamped = mkHit([
      fact({
        validFrom: '2023-05-06T00:00:00.000Z',
        mentionedAt: '2023-05-08T15:56:00.000Z',
      }),
    ]);
    expect(
      buildFactIndex([stamped]).factLines[0],
    ).not.toContain('mentioned');
    const unstamped = mkHit([fact({ validFrom: '2023-05-06T00:00:00.000Z' })]);
    expect(
      buildFactIndex([unstamped], { mentionDates: true }).factLines[0],
    ).not.toContain('mentioned');
  });

  it('renders a bare anchor when validFrom is missing', () => {
    const { factLines } = buildFactIndex(
      [mkHit([fact({ mentionedAt: '2023-05-08T15:56:00.000Z' })])],
      { mentionDates: true },
    );
    expect(factLines[0]).toContain('(mentioned 2023-05-08)');
  });

  it('epoch-sentinel and unparseable anchors render nothing', () => {
    const { factLines } = buildFactIndex(
      [
        mkHit([
          fact({
            validFrom: '2023-05-06T00:00:00.000Z',
            mentionedAt: '1970-01-01T00:00:00.000Z',
          }),
          fact({
            factId: 'knowledge_fact:m2',
            validFrom: '2023-05-06T00:00:00.000Z',
            mentionedAt: 'not-a-date',
          }),
        ]),
      ],
      { mentionDates: true },
    );
    expect(factLines.join('\n')).not.toContain('mentioned');
  });
});

describe('enumeration strict clause (§8 item 3, profile.enumStrict)', () => {
  const base = {
    query: 'What forms of exercise does Melanie do?',
    factLines: ['[knowledge_fact:x] melanie (person) — activities: yoga'],
    answerLang: null,
    lane: 'enumeration' as const,
  };
  it('off: byte-identical historical enumeration frame', () => {
    const off = buildGeneratorUserMessage(base);
    expect(off).toBe(buildGeneratorUserMessage({ ...base, enumStrict: false }));
    expect(off).not.toContain('Match the asked scope LITERALLY');
  });
  it('on: appends the scope clause after the exhaustive frame', () => {
    const on = buildGeneratorUserMessage({ ...base, enumStrict: true });
    expect(on).toContain('a partial list is a wrong answer');
    expect(on).toContain('Match the asked scope LITERALLY');
    expect(on.indexOf('partial list')).toBeLessThan(
      on.indexOf('Match the asked scope'),
    );
  });
  it('does not fire outside the enumeration lane', () => {
    const other = buildGeneratorUserMessage({
      ...base,
      lane: 'preference' as never,
      enumStrict: true,
    });
    expect(other).not.toContain('Match the asked scope LITERALLY');
  });
});
