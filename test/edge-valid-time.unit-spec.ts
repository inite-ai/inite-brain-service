/**
 * Edge valid time on the write path (0164). The production case: a
 * document said "до 24 сентября движок brain работал на gpt-5.6-luna; с 24
 * сентября — на gpt-6-luna", both edges were written timeless, and an
 * asOf=2026-09-22 question was answered "gpt-6-luna". The extractor now
 * resolves a period per edge (eventTime / endTime); this suite pins the
 * pure pieces that carry it to the row: the validator, the pass merge,
 * the candidate merge, edgeTiming's mapping and the writer's CONTENT /
 * fold decisions.
 */
import { edgeTiming } from '../src/ingest/event-time';
import { validateEdges } from '../src/ai/extractor-internals/edge-validator';
import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import { buildExtractionSchema } from '../src/ai/extractor-internals/prompts';
import { mergeCandidates } from '../src/documents/candidate-merge';
import type { CandidateRow } from '../src/documents/candidate-store.service';
import { edgeTimeContent, edgeTimingWidens } from '../src/ingest/edge-writer';

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const SAID = '2026-09-25T10:00:00.000Z';

describe('edgeTiming', () => {
  it('a stated past start is when the relation began', () => {
    expect(edgeTiming({ kind: 'runs_on', eventTime: '2026-09-24' }, SAID)).toEqual({
      validFrom: day('2026-09-24'),
    });
  });

  it('a future start holds from when it was said (factTiming semantics)', () => {
    expect(edgeTiming({ kind: 'works_at', eventTime: '2026-10-01' }, SAID)).toEqual({
      validFrom: new Date(SAID),
    });
  });

  it('no day at all holds from when it was said', () => {
    expect(edgeTiming({ kind: 'knows' }, SAID)).toEqual({ validFrom: new Date(SAID) });
  });

  it('stated only as having ended: unknown start, not the turn', () => {
    const t = edgeTiming({ kind: 'runs_on', endTime: '2026-09-24' }, SAID);
    expect(t).toEqual({ validUntil: day('2026-09-24') });
    expect('validFrom' in t).toBe(false);
  });

  it('a stated start and end make a closed interval', () => {
    expect(
      edgeTiming({ kind: 'works_at', eventTime: '2026-03-01', endTime: '2026-09-24' }, SAID),
    ).toEqual({ validFrom: day('2026-03-01'), validUntil: day('2026-09-24') });
  });

  it('a start not before the end is dropped (unknown start)', () => {
    expect(
      edgeTiming({ kind: 'runs_on', eventTime: '2026-09-24', endTime: '2026-09-24' }, SAID),
    ).toEqual({ validUntil: day('2026-09-24') });
    // A future start falls to the turn, which is after a past end.
    expect(
      edgeTiming({ kind: 'runs_on', eventTime: '2026-10-01', endTime: '2026-09-20' }, SAID),
    ).toEqual({ validUntil: day('2026-09-20') });
  });

  it('an unparseable turn instant yields no start rather than an Invalid Date', () => {
    expect(edgeTiming({ kind: 'knows' }, 'not a date')).toEqual({});
  });
});

describe('validateEdges — eventTime / endTime', () => {
  const edge = (extra: Record<string, unknown>) => ({
    edges: [
      {
        fromEntityIndex: 0,
        toEntityIndex: 1,
        kind: 'runs_on',
        clauseIndex: 0,
        confidence: 0.9,
        ...extra,
      },
    ],
  });

  it('parses the resolved days', () => {
    const { edges } = validateEdges(edge({ eventTime: '2026-09-24', endTime: null }), 2, ['c']);
    expect(edges[0]).toMatchObject({ eventTime: '2026-09-24' });
    expect(edges[0]!.endTime).toBeUndefined();
    const closed = validateEdges(edge({ eventTime: null, endTime: '2026-09-24' }), 2, ['c']);
    expect(closed.edges[0]).toMatchObject({ endTime: '2026-09-24' });
    expect(closed.edges[0]!.eventTime).toBeUndefined();
  });

  it('drops a malformed day but keeps the edge', () => {
    const { edges, dropped } = validateEdges(
      edge({ eventTime: '2026-02-30', endTime: 'yesterday' }),
      2,
      ['c'],
    );
    expect(dropped).toEqual([]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.eventTime).toBeUndefined();
    expect(edges[0]!.endTime).toBeUndefined();
  });
});

describe('extraction schema', () => {
  it('requires both days on every edge (strict JSON schema)', () => {
    const schema = buildExtractionSchema() as {
      properties: { edges: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    const items = schema.properties.edges.items;
    expect(items.required).toEqual(expect.arrayContaining(['eventTime', 'endTime']));
    expect(items.properties.eventTime).toMatchObject({ type: ['string', 'null'] });
    expect(items.properties.endTime).toMatchObject({ type: ['string', 'null'] });
  });
});

describe('mergeExtractions — edge days across passes', () => {
  it('a day only a later pass resolved fills the kept edge', () => {
    const entities = [
      { name: 'brain', type: 'project' as const },
      { name: 'gpt-5.6-luna', type: 'asset' as const },
    ];
    const pass = (extra: Record<string, string>) => ({
      entities,
      facts: [],
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'runs_on', confidence: 0.9, ...extra }],
    });
    const out = mergeExtractions([pass({}), pass({ endTime: '2026-09-24' })]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]!.endTime).toBe('2026-09-24');
  });
});

describe('mergeCandidates — relation days', () => {
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
  const ents = (runId: string) => [
    row('entity', { entityIndex: 0, name: 'brain', type: 'project' }, 0.7, runId),
    row('entity', { entityIndex: 1, name: 'gpt-5.6-luna', type: 'asset' }, 0.7, runId),
  ];
  const rel = (payload: Record<string, unknown>, confidence: number, runId: string) =>
    row(
      'relation',
      { fromEntityIndex: 0, toEntityIndex: 1, kind: 'runs_on', ...payload },
      confidence,
      runId,
    );

  it('carries a single relation’s period', () => {
    const out = mergeCandidates([
      ...ents('indexer_run:r1'),
      rel({ endTime: '2026-09-24' }, 0.8, 'indexer_run:r1'),
    ]);
    expect(out.relations[0]).toMatchObject({ endTime: '2026-09-24' });
    expect(out.relations[0]!.eventTime).toBeUndefined();
  });

  it('a stated day beats none; the more confident contributor’s day wins', () => {
    const out = mergeCandidates([
      ...ents('indexer_run:r1'),
      ...ents('indexer_run:r2'),
      ...ents('indexer_run:r3'),
      rel({ eventTime: '2026-03-01' }, 0.6, 'indexer_run:r1'),
      rel({ endTime: '2026-09-24' }, 0.5, 'indexer_run:r2'),
      rel({ eventTime: '2026-02-01' }, 0.9, 'indexer_run:r3'),
    ]);
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0]).toMatchObject({
      eventTime: '2026-02-01',
      endTime: '2026-09-24',
      confidence: 0.9,
    });
  });
});

describe('edge writer — valid-time CONTENT and fold', () => {
  const now = new Date('2026-09-25T12:00:00Z');

  it('omits unknown sides instead of binding NULL', () => {
    expect(edgeTimeContent({}, '', now)).toEqual({ fields: '', params: {} });
    const open = edgeTimeContent({ validFrom: day('2026-09-24') }, '', now);
    expect(open.fields).toBe(', validFrom: $validFrom');
    expect(Object.keys(open.params)).toEqual(['validFrom']);
  });

  it('a past end closes the knowledge axis too; a future end does not', () => {
    const past = edgeTimeContent({ validUntil: day('2026-09-24') }, '3', now);
    expect(past.fields).toBe(', validUntil: $validUntil3, invalidatedAt: $invalidatedAt3');
    expect(past.params.invalidatedAt3).toBe(now);
    const future = edgeTimeContent({ validUntil: day('2026-10-01') }, '', now);
    expect(future.fields).toBe(', validUntil: $validUntil');
  });

  it('folds only an earlier start or an end the row lacks', () => {
    const stored = { validFrom: '2026-09-20T00:00:00Z' };
    expect(edgeTimingWidens(stored, { validFrom: day('2026-09-01') })).toBe(true);
    expect(edgeTimingWidens(stored, { validFrom: day('2026-09-21') })).toBe(false);
    expect(edgeTimingWidens(stored, { validUntil: day('2026-09-24') })).toBe(true);
    expect(
      edgeTimingWidens(
        { ...stored, validUntil: '2026-09-22T00:00:00Z' },
        { validUntil: day('2026-09-24') },
      ),
    ).toBe(false);
    // An unknown stored start is already the earliest there is.
    expect(edgeTimingWidens({}, { validFrom: day('2020-01-01') })).toBe(false);
  });
});
