/**
 * The open (dialogue) vocabulary's value check (value-entailment.ts). The
 * substring gate was bypassed outright for it, so a value the turn never
 * supported — hallucinated, or written on an injected instruction — was
 * stored as memory. Now a value stands only when what the extractor read
 * supports it: its words, or the local NLI model's entailment.
 */
import {
  isValueWordGrounded,
  numberClash,
  valueCheck,
  statedDates,
  withoutStatedDates,
  valueHypothesis,
  valuePremise,
  valueStands,
} from '../src/ai/extractor-internals/value-entailment';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';
import { ExtractorService } from '../src/ai/extractor.service';
import type { IntentClassifierService } from '../src/admin/intent-classifier.service';
import type { NliLabel } from '../src/admin/nli-entailment';

describe('value check — rules', () => {
  it('words: inflection passes, a compound does not, numbers match exactly', () => {
    expect(isValueWordGrounded('Я переехала в Лиссабон в сентябре.', 'Лиссабон')).toBe(true);
    expect(isValueWordGrounded('Встретимся в Лиссабоне.', 'Лиссабон')).toBe(true);
    expect(isValueWordGrounded("I'm vegetarian, so no steakhouse for me", 'steak')).toBe(false);
    expect(
      isValueWordGrounded('the rate limit is 50 requests per minute', '50 requests per minute'),
    ).toBe(true);
    expect(isValueWordGrounded('Bob is our customer', '123-45-6789')).toBe(false);
  });

  it('a misread number is rejected outright; a spelled-out one is left to NLI', () => {
    expect(numberClash('I picked port 8443 for the service.', '8080')).toBe(true);
    expect(numberClash('I picked port 8443 for the service.', '8443')).toBe(false);
    expect(numberClash('The budget is fifty thousand dollars.', '$50,000')).toBe(false);
    expect(valueCheck('I picked port 8443 for the service.', '8080')).toBe('reject');
  });

  it('a resolved date is computed, never a number clash', () => {
    expect(valueCheck('Let us meet next Tuesday at 3pm.', '2026-11-10')).toBe('not_contradicted');
  });

  it("a date the text names, written as ISO inside a value, is the text's own", () => {
    const said = 'We introduced personalized tours on April 10, 2026, and guests love them.';
    expect(valueCheck(said, 'personalized tours, introduced 2026-04-10')).toBe('not_contradicted');
    expect(withoutStatedDates(said, 'tours, introduced 2026-04-10')).not.toContain('2026');
    // A date the text does not name keeps its digits: a misread day is a clash.
    expect(valueCheck(said, 'personalized tours, introduced 2026-05-10')).toBe('reject');
    // Other languages are read by the parser's own locales.
    expect(statedDates('Мы открылись 10 апреля 2026 года.')).toContain('2026-04-10');
    expect(statedDates('Abrimos em 10 de abril de 2026.')).toContain('2026-04-10');
    // A relative expression names no date.
    expect(statedDates('Let us meet next Tuesday.').size).toBe(0);
  });

  it('words present: stands unless contradicted; otherwise only if entailed; no model: kept', () => {
    expect(valueCheck('My team lead is Marta now, Diego moved on.', 'Diego')).toBe(
      'not_contradicted',
    );
    expect(valueStands('not_contradicted', 'contradiction')).toBe(false);
    expect(valueStands('not_contradicted', 'neutral')).toBe(true);
    expect(valueCheck("I'm not seeing anyone at the moment.", 'single')).toBe('entailed');
    expect(valueStands('entailed', 'neutral')).toBe(false);
    expect(valueStands('entailed', 'entailment')).toBe(true);
    expect(valueStands('entailed', undefined)).toBe(true);
    expect(valueStands('reject', undefined)).toBe(false);
  });

  it('the hypothesis reads as a sentence; the premise leads with the turn', () => {
    expect(
      valueHypothesis({ entityName: 'Ana', predicate: 'works_as', value: 'assistant manager' }),
    ).toBe('Ana works as: assistant manager');
    const premise = valuePremise('now', {
      memory: {
        recentTurns: [
          { at: '2026-01-01', speaker: 'Ana', text: 'first' },
          { at: '2026-01-02', text: 'second' },
        ],
        entities: [],
      } as never,
    });
    expect(premise.split('\n')).toEqual(['now', 'second', 'Ana: first']);
  });
});

describe('value check — in the extraction post-processing (open vocabulary)', () => {
  const saved = process.env.EXTRACTOR_DIALOGUE_PROFILE;
  beforeEach(() => {
    process.env.EXTRACTOR_DIALOGUE_PROFILE = '1';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EXTRACTOR_DIALOGUE_PROFILE;
    else process.env.EXTRACTOR_DIALOGUE_PROFILE = saved;
  });

  const read = async (nli: Partial<IntentClassifierService> | undefined, facts: object[]) => {
    const runner = new ExtractorRunnerService(
      {} as never,
      { persistPatterns: () => {} } as never,
      { applyPredicateRefinements: async () => {} } as never,
      undefined,
      nli as IntentClassifierService | undefined,
    );
    const registry = { getSnapshot: async () => ({ versionHash: 'h', active: [] }) };
    const extractor = new ExtractorService({} as never, registry as never, runner);
    const text = 'Bob is our customer, he signed up on port 8443 day.';
    const result = await extractor.assembleRead({
      text,
      companyId: 'co_a',
      rawJson: {
        clauses: [text],
        entities: [{ name: 'Bob', type: 'person', canonical: null, known: null }],
        facts: facts.map((f) => ({ entityIndex: 0, clauseIndex: 0, confidence: 0.9, ...f })),
        edges: [],
      },
    });
    return result.facts.map((f) => `${f.predicate}=${f.object}`);
  };
  const labelled = (byValue: Record<string, NliLabel>) => ({
    nli: jest.fn(async (_p: string, hypotheses: string[]) =>
      hypotheses.map((h) => byValue[h.split(': ')[1]!] ?? 'neutral'),
    ),
  });

  it('an injected value the turn never supported is dropped; a supported one stays', async () => {
    const nli = labelled({ customer: 'entailment' });
    expect(
      await read(nli, [
        { predicate: 'role', valueSpan: 'customer' },
        { predicate: 'ssn', valueSpan: '123-45-6789' },
      ]),
    ).toEqual(['role=customer']);
  });

  it('a misread number goes without asking the model; with no model the rest is kept', async () => {
    expect(
      await read(undefined, [
        { predicate: 'port', valueSpan: '8080' },
        { predicate: 'segment', valueSpan: 'enterprise' },
      ]),
    ).toEqual(['segment=enterprise']);
  });

  it('a value whose words are present but which the turn contradicts is dropped', async () => {
    const nli = labelled({ customer: 'contradiction' });
    expect(await read(nli, [{ predicate: 'role', valueSpan: 'customer' }])).toEqual([]);
  });
});
