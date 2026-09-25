/**
 * A fact's end on the write path. The production case: a document said
 * "до 24 сентября движок brain работал на gpt-5.6-luna; с 24 сентября — на
 * gpt-6-luna", and the extractor could file only the 6 value (validFrom
 * the 24th) — a fact had no way to say the 5.6 state held UNTIL the 24th,
 * so asOf=2026-09-22 had no answer. The extractor now resolves `endTime`
 * per fact, as it does per edge; this suite pins the pure pieces that
 * carry it to the row: the parser + grounding gate, the pass merge, the
 * candidate merge and factTiming's mapping.
 */
import { UNKNOWN_START, factTiming } from '../src/ingest/event-time';
import { applyGroundingGate, parseRawFacts } from '../src/ai/extractor-internals/grounding';
import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import { buildExtractionSchema } from '../src/ai/extractor-internals/prompts';
import { mergeCandidates } from '../src/documents/candidate-merge';
import type { CandidateRow } from '../src/documents/candidate-store.service';

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const SAID = '2026-09-25T10:00:00.000Z';
const OFF = { on: false };

describe('factTiming — endTime', () => {
  it('no end: the start rule is unchanged and no validUntil is set', () => {
    const t = factTiming({ predicate: 'engine_model', eventTime: '2026-09-24' }, SAID, OFF);
    expect(t).toEqual({ validFrom: day('2026-09-24'), objectMeta: { date: '2026-09-24' } });
    expect('validUntil' in t).toBe(false);
  });

  it('stated only as having ended: unknown start (the epoch sentinel), end at 00:00Z', () => {
    expect(factTiming({ predicate: 'engine_model', endTime: '2026-09-24' }, SAID, OFF)).toEqual({
      validFrom: UNKNOWN_START,
      validUntil: day('2026-09-24'),
    });
    expect(UNKNOWN_START.getTime()).toBe(0);
  });

  it('the chrono lane never reads the end as the start', () => {
    // With the lane on, the clause's "24 сентября" would parse as a past
    // date — the day the value ENDED, not when it began.
    const t = factTiming(
      {
        predicate: 'engine_model',
        clause: 'до 24 сентября движок работал на gpt-5.6-luna',
        endTime: '2026-09-24',
      },
      SAID,
      { on: true },
    );
    expect(t.validFrom).toBe(UNKNOWN_START);
  });

  it('a stated start and end make a closed interval', () => {
    expect(
      factTiming(
        { predicate: 'works_as', eventTime: '2026-03-01', endTime: '2026-09-24' },
        SAID,
        OFF,
      ),
    ).toEqual({
      validFrom: day('2026-03-01'),
      validUntil: day('2026-09-24'),
      objectMeta: { date: '2026-03-01' },
    });
  });

  it('a start not before the end is unknown', () => {
    expect(
      factTiming(
        { predicate: 'engine_model', eventTime: '2026-09-24', endTime: '2026-09-24' },
        SAID,
        OFF,
      ),
    ).toMatchObject({ validFrom: UNKNOWN_START, validUntil: day('2026-09-24') });
    // A future start falls to the turn, which is after a past end.
    expect(
      factTiming(
        { predicate: 'engine_model', eventTime: '2026-10-01', endTime: '2026-09-20' },
        SAID,
        OFF,
      ),
    ).toMatchObject({ validFrom: UNKNOWN_START, validUntil: day('2026-09-20') });
  });

  it('a future end keeps a known start (the value holds until then)', () => {
    expect(
      factTiming(
        { predicate: 'contract', eventTime: '2026-09-01', endTime: '2026-12-31' },
        SAID,
        OFF,
      ),
    ).toMatchObject({ validFrom: day('2026-09-01'), validUntil: day('2026-12-31') });
  });

  it('a malformed end is ignored', () => {
    expect(factTiming({ predicate: 'x', endTime: 'yesterday' }, SAID, OFF)).toEqual({
      validFrom: new Date(SAID),
    });
  });
});

describe('extractor output — endTime per fact', () => {
  it('the schema requires it, nullable (strict JSON schema)', () => {
    const schema = buildExtractionSchema() as {
      properties: { facts: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    const items = schema.properties.facts.items;
    expect(items.required).toEqual(expect.arrayContaining(['eventTime', 'endTime']));
    expect(items.properties.endTime).toMatchObject({ type: ['string', 'null'] });
  });

  it('parses and grounds it; a malformed day is dropped, the fact kept', () => {
    const text = 'до 24 сентября движок работал на gpt-5.6-luna';
    const raw = parseRawFacts(
      {
        facts: [
          {
            entityIndex: 0,
            clauseIndex: 0,
            predicate: 'engine_model',
            valueSpan: 'gpt-5.6-luna',
            confidence: 0.9,
            eventTime: null,
            endTime: '2026-09-24',
          },
          {
            entityIndex: 0,
            clauseIndex: 0,
            predicate: 'engine_model',
            valueSpan: 'gpt-5.6-luna',
            confidence: 0.9,
            eventTime: null,
            endTime: '2026-02-30',
          },
        ],
      },
      1,
    );
    expect(raw[0]).toMatchObject({ endTime: '2026-09-24' });
    expect(raw[1]!.endTime).toBeUndefined();
    const { facts } = applyGroundingGate(text, raw, { clauses: [text] });
    expect(facts[0]).toMatchObject({ object: 'gpt-5.6-luna', endTime: '2026-09-24' });
    expect(facts[0]!.eventTime).toBeUndefined();
  });

  it('a day only a later self-consistency pass resolved fills the kept fact', () => {
    const pass = (extra: Record<string, string>) => ({
      entities: [{ name: 'brain', type: 'project' as const }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'engine_model',
          object: 'gpt-5.6-luna',
          confidence: 0.9,
          ...extra,
        },
      ],
      edges: [],
    });
    const out = mergeExtractions([pass({}), pass({ endTime: '2026-09-24' })]);
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]!.endTime).toBe('2026-09-24');
  });
});

describe('mergeCandidates — fact days', () => {
  let seq = 0;
  const row = (
    kind: CandidateRow['kind'],
    payload: Record<string, unknown>,
    confidence = 0.7,
    runId = 'indexer_run:r1',
  ): CandidateRow => ({
    id: `candidate:c${seq++}`,
    runId,
    chunkSeq: 0,
    kind,
    confidence,
    status: 'pending',
    payload,
  });
  const ent = (runId: string) =>
    row('entity', { entityIndex: 0, name: 'brain', type: 'project' }, 0.7, runId);
  const fact = (payload: Record<string, unknown>, confidence: number, runId: string) =>
    row(
      'fact',
      { entityIndex: 0, predicate: 'engine_model', object: 'gpt-5.6-luna', ...payload },
      confidence,
      runId,
    );

  it('carries a single fact’s end', () => {
    const out = mergeCandidates([
      ent('indexer_run:r1'),
      fact({ endTime: '2026-09-24' }, 0.8, 'indexer_run:r1'),
    ]);
    expect(out.facts[0]).toMatchObject({ endTime: '2026-09-24' });
  });

  it('a stated day beats none; the more confident contributor’s day wins', () => {
    const out = mergeCandidates([
      ent('indexer_run:r1'),
      ent('indexer_run:r2'),
      ent('indexer_run:r3'),
      fact({ eventTime: '2026-03-01' }, 0.6, 'indexer_run:r1'),
      fact({ endTime: '2026-09-24' }, 0.5, 'indexer_run:r2'),
      fact({ eventTime: '2026-02-01' }, 0.9, 'indexer_run:r3'),
    ]);
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]).toMatchObject({ eventTime: '2026-02-01', endTime: '2026-09-24' });
  });
});
