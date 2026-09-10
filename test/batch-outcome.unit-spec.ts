/**
 * The shared batch terminal-status contract (src/common/batch-outcome.ts):
 * the fold rules, the roster fold, the job-result probe, the `keys`
 * selector belt, and wire parity with the zod contract the OpenAPI
 * document publishes.
 */
import { BadRequestException } from '@nestjs/common';
import {
  batchOutcomeOf,
  describeBatchOutcome,
  emptyBatchOutcome,
  failedBatchOutcome,
  foldBatchOutcome,
  foldNestedOutcomes,
  parseBatchKeys,
  type BatchOutcome,
} from '../src/common/batch-outcome';
import {
  BatchOutcomeSchema,
  type BatchOutcomeWire,
} from '../src/contracts/common/batch-outcome.schema';

describe('foldBatchOutcome', () => {
  it('complete: every unit landed and nothing degraded', () => {
    expect(foldBatchOutcome({ total: 3, succeeded: 3, failed: [] })).toEqual({
      status: 'complete',
      total: 3,
      succeeded: 3,
      failed: [],
      degradedBy: [],
    });
  });

  it('an empty batch is complete, not failed', () => {
    expect(emptyBatchOutcome().status).toBe('complete');
  });

  it('degraded: some units failed', () => {
    const o = foldBatchOutcome({
      total: 3,
      succeeded: 2,
      failed: [{ key: 'c2', error: 'llm down' }],
    });
    expect(o.status).toBe('degraded');
    expect(o.failed.map((f) => f.key)).toEqual(['c2']);
  });

  it('degraded: every unit landed but a post-pass failed', () => {
    const o = foldBatchOutcome({
      total: 3,
      succeeded: 3,
      failed: [],
      degradedBy: [{ key: 'post-pass:enrich', error: '2 of 3 scene(s) failed' }],
    });
    expect(o.status).toBe('degraded');
    expect(o.failed).toEqual([]);
    expect(o.degradedBy[0]?.key).toBe('post-pass:enrich');
  });

  it('failed: units were attempted and none succeeded', () => {
    const o = foldBatchOutcome({
      total: 2,
      succeeded: 0,
      failed: [
        { key: 'c1', error: 'x' },
        { key: 'c2', error: 'x' },
      ],
    });
    expect(o.status).toBe('failed');
  });

  it('failedBatchOutcome names the operation itself under key *', () => {
    expect(failedBatchOutcome('boom')).toEqual({
      status: 'failed',
      total: 0,
      succeeded: 0,
      failed: [{ key: '*', error: 'boom' }],
      degradedBy: [],
    });
  });
});

describe('foldNestedOutcomes', () => {
  const complete = foldBatchOutcome({ total: 1, succeeded: 1, failed: [] });
  const degraded = foldBatchOutcome({
    total: 2,
    succeeded: 1,
    failed: [{ key: 'c1', error: 'x' }],
  });
  const failed = failedBatchOutcome('down');

  it('a failed part is a failed unit; a degraded part degrades the whole', () => {
    const o = foldNestedOutcomes([
      { key: 'co_a', outcome: complete },
      { key: 'co_b', outcome: degraded },
      { key: 'co_c', outcome: failed },
    ]);
    expect(o.status).toBe('degraded');
    expect(o.total).toBe(3);
    expect(o.succeeded).toBe(2);
    expect(o.failed.map((f) => f.key)).toEqual(['co_c']);
    expect(o.degradedBy.map((f) => f.key)).toEqual(['co_b']);
  });

  it('all parts failed ⇒ failed; all complete ⇒ complete', () => {
    expect(foldNestedOutcomes([{ key: 'a', outcome: failed }]).status).toBe('failed');
    expect(foldNestedOutcomes([{ key: 'a', outcome: complete }]).status).toBe('complete');
    expect(foldNestedOutcomes([]).status).toBe('complete');
  });
});

describe('describeBatchOutcome / batchOutcomeOf', () => {
  it('summarises counts and the first failure', () => {
    const o = foldBatchOutcome({
      total: 3,
      succeeded: 1,
      failed: [{ key: 'c2', error: 'llm down' }],
      degradedBy: [{ key: 'post-pass:compose', error: 'c1: timeout' }],
    });
    expect(describeBatchOutcome(o)).toBe(
      'degraded: 1 of 3 unit(s) succeeded (1 failed, 1 degrading); first: c2 — llm down',
    );
    expect(describeBatchOutcome(emptyBatchOutcome())).toBe('complete: 0 of 0 unit(s) succeeded');
  });

  it('probes a job result for a well-formed outcome only', () => {
    const outcome = failedBatchOutcome('x');
    expect(batchOutcomeOf({ outcome })).toBe(outcome);
    expect(batchOutcomeOf({ outcome: { status: 'nope', failed: [] } })).toBeUndefined();
    expect(batchOutcomeOf({ outcome: { status: 'failed' } })).toBeUndefined();
    expect(batchOutcomeOf({ marked: 3 })).toBeUndefined();
    expect(batchOutcomeOf(undefined)).toBeUndefined();
    expect(batchOutcomeOf(null)).toBeUndefined();
  });
});

describe('parseBatchKeys', () => {
  const belt = { maxKeys: 3, maxLength: 8 };

  it('absent ⇒ undefined; trims and dedupes present keys', () => {
    expect(parseBatchKeys(undefined, belt)).toBeUndefined();
    expect(parseBatchKeys([' c1 ', 'c2', 'c1'], belt)).toEqual(['c1', 'c2']);
  });

  it('400s on a non-array, an empty array, too many, blank, too long, or rejected keys', () => {
    for (const bad of ['c1', [], ['a', 'b', 'c', 'd'], [''], ['123456789'], [42]]) {
      expect(() => parseBatchKeys(bad, belt)).toThrow(BadRequestException);
    }
    expect(() => parseBatchKeys(['x:1'], { ...belt, accept: (k) => k.startsWith('y:') })).toThrow(
      BadRequestException,
    );
    expect(parseBatchKeys(['y:1'], { ...belt, accept: (k) => k.startsWith('y:') })).toEqual([
      'y:1',
    ]);
  });
});

describe('wire parity with src/contracts/common/batch-outcome.schema.ts', () => {
  it('the zod contract accepts a real outcome key-for-key, and the types agree', () => {
    const outcome: BatchOutcome = foldBatchOutcome({
      total: 2,
      succeeded: 1,
      failed: [{ key: 'c1', error: 'x' }],
      degradedBy: [{ key: 'post-pass:enrich', error: 'y' }],
    });
    const parsed = BatchOutcomeSchema.parse(outcome);
    expect(parsed).toEqual(outcome);
    expect(Object.keys(BatchOutcomeSchema.shape).sort()).toEqual(Object.keys(outcome).sort());
    // Compile-time parity in both directions.
    const wire: BatchOutcomeWire = outcome;
    const back: BatchOutcome = wire;
    expect(back).toBe(outcome);
  });
});
