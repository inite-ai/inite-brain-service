/**
 * Foresight (0166): a temporary state carries when it is expected to be
 * over, and that expectation is never an end.
 *  - write: the extractor's expectedEnd survives parsing, the SC merge and
 *    the write-time guard (after the turn, after the start, ≤ a year);
 *  - the resolve lands it on the right row, and a restatement moves it
 *    on every open row of the same value;
 *  - read: the line says "expected until D" while D is ahead and "expected
 *    over by D; not confirmed since" once it has passed — judged against
 *    the query's asOf in code — and the generator is told what that means
 *    only when a line carries one;
 *  - the extractor sees the expectation on its KNOWN FACTS.
 */
import { factExpectation, MAX_EXPECTATION_DAYS } from '../src/ingest/event-time';
import {
  EXPECTATION_MARK,
  expectationTarget,
  formatExpectation,
  restatedExpectation,
} from '../src/ingest/fact-expectation';
import type { ResolveOutcome } from '../src/ingest/conflict-resolver';
import { parseRawFacts } from '../src/ai/extractor-internals/grounding';
import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import { renderMemoryFact } from '../src/ai/extractor-internals/memory-context';
import {
  buildExtractionSchema,
  MEMORY_CONTRACT_SECTION,
} from '../src/ai/extractor-internals/prompts';
import type { ExtractionResult } from '../src/ai/extractor-internals/types';
import { buildFactIndex } from '../src/synthesize/fact-index';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';
import type { SearchHit } from '../src/search/search.types';

const DAY = 86_400_000;
const said = '2026-09-25T15:00:00Z';
const turn = new Date(said);

describe('the write-time guard (factExpectation)', () => {
  it('a day after the turn becomes that day at 00:00Z', () => {
    expect(factExpectation('2026-10-02', said, turn)?.toISOString()).toBe(
      '2026-10-02T00:00:00.000Z',
    );
  });

  it.each([
    ['no expectation', undefined],
    ['not a day', 'next week'],
    ['the day it was said (already begun)', '2026-09-25'],
    ['before the turn', '2026-09-20'],
  ])('%s → none', (_label, day) => {
    expect(factExpectation(day, said, turn)).toBeUndefined();
  });

  it('never at or before the start of the state it bounds', () => {
    const scheduledStart = new Date('2026-10-05T00:00:00Z');
    expect(factExpectation('2026-10-03', said, scheduledStart)).toBeUndefined();
    expect(factExpectation('2026-10-09', said, scheduledStart)?.toISOString()).toBe(
      '2026-10-09T00:00:00.000Z',
    );
  });

  it('further out than a year is a permanent state misread → none', () => {
    const far = new Date(turn.getTime() + (MAX_EXPECTATION_DAYS + 2) * DAY)
      .toISOString()
      .slice(0, 10);
    expect(factExpectation(far, said, turn)).toBeUndefined();
  });
});

describe('the row the resolve landed on (expectationTarget)', () => {
  const r = (o: Partial<ResolveOutcome>): ResolveOutcome =>
    ({ outcome: 'INSERTED', factId: 'knowledge_fact:new', ...o }) as ResolveOutcome;

  it.each(['INSERTED', 'INSERTED_HISTORICAL', 'SUPERSEDED', 'COMPETING'] as const)(
    '%s → the new row',
    (outcome) => {
      expect(expectationTarget(r({ outcome }))).toBe('knowledge_fact:new');
    },
  );

  it('CORROBORATED → the corroborated row, not the audit record', () => {
    expect(
      expectationTarget(
        r({ outcome: 'CORROBORATED', corroboratedFactId: 'knowledge_fact:incumbent' }),
      ),
    ).toBe('knowledge_fact:incumbent');
  });

  it.each(['REJECTED', 'SKIPPED'] as const)('%s → nothing landed', (outcome) => {
    expect(expectationTarget(r({ outcome }))).toBeNull();
  });

  it('a bare tail is qualified with the table', () => {
    expect(expectationTarget(r({ factId: 'abc' }))).toBe('knowledge_fact:abc');
  });
});

describe('what a statement does to the open rows of the same value (restatedExpectation)', () => {
  const first = { validFrom: '2026-09-01T10:00:00Z', expectedUntil: '2026-09-08T10:00:00Z' };
  const at = (iso: string) => new Date(iso);

  it('its own expectation is set on all of them', () => {
    const own = at('2026-09-20T00:00:00Z');
    expect(
      restatedExpectation(
        [first, { validFrom: '2026-09-10T10:00:00Z' }],
        at('2026-09-10T10:00:00Z'),
        own,
      ),
    ).toBe(own);
  });

  it('without one: the span the state was given, counted again from the statement', () => {
    expect(
      restatedExpectation(
        [first, { validFrom: '2026-09-10T10:00:00Z' }],
        at('2026-09-10T10:00:00Z'),
        undefined,
      )?.toISOString(),
    ).toBe('2026-09-17T10:00:00.000Z');
  });

  it('never pulls the expectation earlier', () => {
    // A shift that lands earlier than what is on file, or older news:
    // the rows keep the expectation they have.
    for (const statedAt of ['2026-09-01T09:00:00Z', '2026-08-01T00:00:00Z']) {
      const next = restatedExpectation([first], at(statedAt), undefined);
      expect(next === undefined || next.toISOString() === '2026-09-08T10:00:00.000Z').toBe(true);
    }
  });

  it('a statement older than a row on file moves nothing — its own row joins the latest', () => {
    expect(
      restatedExpectation(
        [first],
        at('2026-08-20T00:00:00Z'),
        at('2026-08-27T00:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-09-08T10:00:00.000Z');
    expect(
      restatedExpectation(
        [{ validFrom: first.validFrom }],
        at('2026-08-20T00:00:00Z'),
        at('2026-08-27T00:00:00Z'),
      ),
    ).toBeUndefined();
  });

  it('nobody gave the state an expectation → the rows stay as they are', () => {
    expect(
      restatedExpectation([{ validFrom: first.validFrom }], at('2026-09-10T10:00:00Z'), undefined),
    ).toBeUndefined();
  });
});

describe('the rendered expectation (formatExpectation)', () => {
  it('ahead of the judged instant → still holds', () => {
    expect(formatExpectation('2026-10-02T00:00:00Z', said)).toBe(
      ' (temporary — expected until 2026-10-02)',
    );
  });

  it('passed → expected over, nothing confirmed it since', () => {
    expect(formatExpectation('2026-09-20T00:00:00Z', said)).toBe(
      ' (temporary — expected over by 2026-09-20; not confirmed since)',
    );
  });

  it('a Date from the driver reads the same as its string', () => {
    expect(formatExpectation(new Date('2026-10-02T00:00:00Z'), said)).toBe(
      formatExpectation('2026-10-02T00:00:00Z', said),
    );
  });

  it.each([undefined, null, '', 'garbage'])('%p → nothing', (v) => {
    expect(formatExpectation(v, said)).toBe('');
  });
});

describe('the extraction contract', () => {
  it('expectedEnd is a required nullable field and the MEMORY section explains it', () => {
    const schema = buildExtractionSchema() as {
      properties: {
        facts: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    expect(schema.properties.facts.items.properties.expectedEnd).toMatchObject({
      type: ['string', 'null'],
    });
    expect(schema.properties.facts.items.required).toContain('expectedEnd');
    expect(MEMORY_CONTRACT_SECTION).toContain('expectedEnd (per fact)');
    expect(MEMORY_CONTRACT_SECTION).toMatch(/FACT marked "\(expected until …\)"/);
    // A stated end is endTime's (0165); the expectation is for an unstated one.
    expect(MEMORY_CONTRACT_SECTION).toMatch(
      /a stated end —\s+"until Friday", "this week" — is endTime/,
    );
  });

  it('the parser keeps a day and drops anything else', () => {
    const facts = parseRawFacts(
      {
        facts: [
          { entityIndex: 0, predicate: 'health', valueSpan: 'flu', expectedEnd: '2026-10-02' },
          { entityIndex: 0, predicate: 'job', valueSpan: 'CTO', expectedEnd: null },
          { entityIndex: 0, predicate: 'trip', valueSpan: 'Berlin', expectedEnd: 'soon' },
        ],
      },
      1,
    );
    expect(facts.map((f) => f.expectedEnd)).toEqual(['2026-10-02', undefined, undefined]);
  });

  it('an expectation only a later SC pass read still bounds the merged fact', () => {
    const pass = (expectedEnd?: string): ExtractionResult => ({
      entities: [{ name: 'Mike', type: 'staff' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'health',
          object: 'flu',
          confidence: 0.9,
          ...(expectedEnd ? { expectedEnd } : {}),
        },
      ],
      edges: [],
    });
    const merged = mergeExtractions([pass(), pass('2026-10-02'), pass('2026-10-05')]);
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0]!.expectedEnd).toBe('2026-10-02');
  });

  it('a KNOWN FACT shows its expectation next to its start', () => {
    expect(
      renderMemoryFact({
        handle: 'm1',
        id: 'knowledge_fact:x',
        entityHandle: 'e1',
        predicate: 'health',
        object: 'flu',
        since: '2026-09-25',
        expectedUntil: '2026-10-02',
      }),
    ).toBe('[m1] e1 · health: flu (since 2026-09-25) (expected until 2026-10-02)');
  });
});

describe('the answer plane', () => {
  const hit = (expectedUntil?: string): SearchHit =>
    ({
      entityId: 'knowledge_entity:mike',
      entityType: 'staff',
      canonicalName: 'Mike',
      externalRefs: {},
      score: 1,
      facts: [
        {
          factId: 'knowledge_fact:flu',
          predicate: 'health',
          object: 'flu',
          confidence: 0.9,
          score: 1,
          validFrom: '2026-09-25T00:00:00.000Z',
          ...(expectedUntil ? { expectedUntil } : {}),
          status: 'active',
        },
      ],
    }) as unknown as SearchHit;

  it('the line is judged at the instant it is asked for — asOf moves it', () => {
    const lineAt = (at: string) =>
      buildFactIndex([hit('2026-10-02T00:00:00.000Z')], { expectationsAt: at }).factLines[0];
    expect(lineAt('2026-09-28T00:00:00Z')).toBe(
      '[f1] Mike (staff) — health: flu (as of 2026-09-25) (temporary — expected until 2026-10-02)',
    );
    expect(lineAt('2026-10-20T00:00:00Z')).toBe(
      '[f1] Mike (staff) — health: flu (as of 2026-09-25) (temporary — expected over by 2026-10-02; not confirmed since)',
    );
  });

  it('a fact without an expectation renders as before', () => {
    expect(buildFactIndex([hit()], { expectationsAt: said }).factLines[0]).toBe(
      '[f1] Mike (staff) — health: flu (as of 2026-09-25)',
    );
  });

  it('the generator is told what an expectation means only when a line carries one', () => {
    const base = { query: 'Am I sick?', answerLang: null };
    const withMark = buildGeneratorUserMessage({
      ...base,
      factLines: [
        `[f1] you — health: flu ${EXPECTATION_MARK}over by 2026-10-02; not confirmed since)`,
      ],
    });
    expect(withMark).toContain('never state it as the current state');
    const without = buildGeneratorUserMessage({ ...base, factLines: ['[f1] you — health: flu'] });
    expect(without).not.toContain('temporary states');
  });
});
