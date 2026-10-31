/**
 * Fact resolution (#828, src/dreams/fact-resolution.ts): the judge names
 * the relation; valid time decides which of two successive values is the
 * later one — a late-arriving older value goes into history.
 */
import {
  parseResolution,
  resolutionActions,
  resolutionUserContent,
  type ResolvableFact,
} from '../src/dreams/fact-resolution';

const f = (id: string, object: string, validFrom: string, recordedAt: string): ResolvableFact => ({
  id,
  predicate: 'queue_backend',
  object,
  validFrom,
  recordedAt,
});

describe('resolutionActions — valid-time precedence', () => {
  const redis = f(
    'knowledge_fact:redis',
    'Redis Streams',
    '2026-03-02T09:00:00Z',
    '2026-10-29T10:00:00Z',
  );
  const nats = f(
    'knowledge_fact:nats',
    'NATS JetStream',
    '2026-03-18T10:00:00Z',
    '2026-10-29T09:00:00Z',
  );

  it('replaces: the earlier-valid value closes, even when it arrived last', () => {
    // NATS was written first; the older Redis value arrives later.
    expect(resolutionActions(redis, [nats], new Map([[0, 'replaces']]))).toEqual([
      { kind: 'supersede', loser: 'knowledge_fact:redis', winner: 'knowledge_fact:nats' },
    ]);
    expect(resolutionActions(nats, [redis], new Map([[0, 'replaces']]))).toEqual([
      { kind: 'supersede', loser: 'knowledge_fact:redis', winner: 'knowledge_fact:nats' },
    ]);
  });

  it('same: the later-learned row corroborates the earlier one', () => {
    const again = f(
      'knowledge_fact:again',
      'NATS JetStream (JetStream)',
      '2026-03-18T10:00:00Z',
      '2026-10-29T11:00:00Z',
    );
    expect(resolutionActions(again, [nats], new Map([[0, 'same']]))).toEqual([
      { kind: 'corroborate', incumbent: 'knowledge_fact:nats', younger: 'knowledge_fact:again' },
    ]);
  });

  it('contradicts: both stand, competing; unrelated and missing verdicts change nothing', () => {
    const other = f('knowledge_fact:x', 'Kafka', '2026-03-18T10:00:00Z', '2026-10-29T12:00:00Z');
    expect(
      resolutionActions(
        other,
        [nats, redis],
        new Map([
          [0, 'contradicts'],
          [1, 'unrelated'],
        ]),
      ),
    ).toEqual([{ kind: 'compete', a: 'knowledge_fact:nats', b: 'knowledge_fact:x' }]);
    expect(resolutionActions(other, [nats], new Map())).toEqual([]);
  });

  it('an equal valid time falls back to arrival order', () => {
    const a = f('knowledge_fact:a', 'A', '2026-03-18T10:00:00Z', '2026-10-29T09:00:00Z');
    const b = f('knowledge_fact:b', 'B', '2026-03-18T10:00:00Z', '2026-10-29T10:00:00Z');
    expect(resolutionActions(b, [a], new Map([[0, 'replaces']]))).toEqual([
      { kind: 'supersede', loser: 'knowledge_fact:a', winner: 'knowledge_fact:b' },
    ]);
  });
});

describe('parseResolution', () => {
  it('reads r/c handles and drops anything malformed', () => {
    const out = parseResolution({
      items: [
        {
          item: 'r1',
          verdicts: [
            { candidate: 'c2', verdict: 'replaces' },
            { candidate: 'c1', verdict: 'maybe' },
          ],
        },
        { item: 'x', verdicts: [] },
        { item: 'r2', verdicts: 'nope' },
      ],
    });
    expect([...out.keys()]).toEqual([0]);
    expect([...out.get(0)!.entries()]).toEqual([[1, 'replaces']]);
    expect(parseResolution(null).size).toBe(0);
  });
});

describe('resolutionUserContent', () => {
  it('numbers items and candidates with their valid time', () => {
    const text = resolutionUserContent([
      {
        entity: 'ledger-sync',
        fact: f('n', 'NATS JetStream', '2026-03-18T10:00:00Z', '2026-10-29T09:00:00Z'),
        candidates: [f('r', 'Redis Streams', '2026-03-02T09:00:00Z', '2026-10-29T10:00:00Z')],
      },
    ]);
    expect(text).toBe(
      'Item r1 — entity: ledger-sync\nNEW: queue_backend: NATS JetStream (holds from 2026-03-18)\nc1: queue_backend: Redis Streams (holds from 2026-03-02)',
    );
  });
});

describe('resolutionUserContent — sources', () => {
  it('shows what each fact was read from', () => {
    const text = resolutionUserContent([
      {
        entity: 'meridian',
        fact: {
          ...f('a', '16:30 UTC', '2026-03-25T00:00:00Z', '2026-10-29T09:00:00Z'),
          source: '"Meridian API docs v2.3 state 16:30 UTC."',
        },
        candidates: [
          {
            ...f('b', '17:00 UTC', '2026-03-10T00:00:00Z', '2026-10-29T08:00:00Z'),
            source: 'written by mcp_agent (Priya)',
          },
        ],
      },
    ]);
    expect(text).toContain('— from "Meridian API docs v2.3 state 16:30 UTC."');
    expect(text).toContain('— from written by mcp_agent (Priya)');
  });
});
