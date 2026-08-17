import { buildDateMathLines } from './date-math';
import { detectAnswerShape, shapeInstructionFor } from './answer-shape';
import { buildGeneratorUserMessage } from './generator-prompt';
import type { SearchHit } from '../search/search.types';

function hit(
  facts: Array<Partial<SearchHit['facts'][number]>>,
): SearchHit {
  return {
    entityId: 'entity:a',
    entityType: 'person',
    canonicalName: 'Caroline',
    externalRefs: {},
    score: 1,
    facts: facts.map((f, i) => ({
      factId: `knowledge_fact:${i}`,
      predicate: 'events',
      object: 'x',
      confidence: 0.9,
      validFrom: '2023-05-04T00:00:00.000Z',
      status: 'active',
      score: 1,
      ...f,
    })),
  };
}

describe('buildDateMathLines (V13 RETRIEVAL_DATE_MATH)', () => {
  it('renders weekday plus event-to-event gaps, chronological', () => {
    const lines = buildDateMathLines([
      hit([
        { validFrom: '2023-05-07T10:00:00.000Z' },
        { validFrom: '2023-05-04T09:00:00.000Z' },
      ]),
    ]);
    expect(lines).toEqual([
      '2023-05-04 = Thursday',
      '2023-05-07 = Sunday, 3 days after 2023-05-04',
    ]);
  });

  it('never references today (the measured LME anti-pattern)', () => {
    const lines = buildDateMathLines([
      hit([{ validFrom: '2023-05-04T00:00:00.000Z' }]),
    ]);
    expect(lines.join('\n')).not.toMatch(/today|before now|ago/i);
  });

  it('skips the epoch "undated" sentinel and dedupes same-day stamps', () => {
    const lines = buildDateMathLines([
      hit([
        { validFrom: '1970-01-01T00:00:00.000Z' },
        { validFrom: '2023-05-04T08:00:00.000Z' },
        { validFrom: '2023-05-04T23:00:00.000Z' },
      ]),
    ]);
    expect(lines).toEqual(['2023-05-04 = Thursday']);
  });

  it('counts mention anchors and returns [] with no dated facts', () => {
    expect(
      buildDateMathLines([
        hit([
          {
            validFrom: '1970-01-01T00:00:00.000Z',
            mentionedAt: '2023-05-05T12:00:00.000Z',
          },
        ]),
      ]),
    ).toEqual(['2023-05-05 = Friday']);
    expect(
      buildDateMathLines([hit([{ validFrom: '1970-01-01T00:00:00.000Z' }])]),
    ).toEqual([]);
  });
});

describe('detectAnswerShape (V13 G2)', () => {
  it('routes why/how-connection questions to chained', () => {
    expect(detectAnswerShape('Why did Melanie sell her camper?')).toBe(
      'chained',
    );
    expect(
      detectAnswerShape('What led to the connection between Amy and the gym?'),
    ).toBe('chained');
  });

  it('routes broad-coverage questions to aggregation', () => {
    expect(detectAnswerShape("Tell me about John's family")).toBe(
      'aggregation',
    );
    expect(detectAnswerShape('Describe the trip to Portland')).toBe(
      'aggregation',
    );
  });

  it('routes verbatim-recall questions to verbatim', () => {
    expect(
      detectAnswerShape('What was your recommendation for the API limiter?'),
    ).toBe('verbatim');
  });

  it('returns null for plain factual questions', () => {
    expect(detectAnswerShape('When is the marathon?')).toBeNull();
  });

  it('every shape has a non-empty instruction', () => {
    for (const s of ['chained', 'aggregation', 'verbatim'] as const) {
      expect(shapeInstructionFor(s).length).toBeGreaterThan(20);
    }
  });
});

describe('generator prompt — V13 sections are strictly additive', () => {
  const base = {
    query: 'q',
    factLines: ['[knowledge_fact:1] Caroline (person) — events: x'],
    answerLang: null,
  };

  it('byte-identical without the new fields', () => {
    expect(buildGeneratorUserMessage({ ...base })).toBe(
      buildGeneratorUserMessage({
        ...base,
        dateMathLines: undefined,
        shapeInstruction: undefined,
      }),
    );
    expect(buildGeneratorUserMessage({ ...base, dateMathLines: [] })).toBe(
      buildGeneratorUserMessage({ ...base }),
    );
  });

  it('renders the date table and the shape frame when supplied', () => {
    const out = buildGeneratorUserMessage({
      ...base,
      dateMathLines: ['2023-05-04 = Thursday'],
      shapeInstruction: 'Answer shape: test frame.\n',
    });
    expect(out).toContain('Date table (computed from the fact date stamps');
    expect(out).toContain('2023-05-04 = Thursday');
    expect(out).toContain('Answer shape: test frame.');
  });
});
