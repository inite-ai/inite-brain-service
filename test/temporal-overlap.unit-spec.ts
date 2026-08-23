import { buildBaseWhere } from '../src/search/internals/where-builder';
import { scoreRows } from '../src/search/internals/scoring';
import { resolveRetrievalProfileFor } from '../src/search/retrieval-profile';
import type { FusedRow } from '../src/search/internals/types';

/**
 * Audit W4 #17: temporal used to be a hard filter, never a boost — a bad
 * asOf was a recall cliff. Profile temporalMode='overlap_boost' relaxes
 * the asOf validity closure and decays out-of-interval facts by distance
 * (Hindsight: overlap + distance decay = 91.0 TR).
 */
describe('where-builder temporalMode', () => {
  const base = {
    dto: {} as never,
    asOf: new Date('2023-06-01T00:00:00Z'),
    includeRetracted: false,
    includeContested: false,
    derivedVersion: null,
  };

  it("default 'filter' keeps the strict validity closure", () => {
    const { sql } = buildBaseWhere(base);
    expect(sql).toContain('validFrom <= $asOf');
    expect(sql).toContain('validUntil IS NONE OR validUntil > $asOf');
  });

  it("'overlap_boost' drops the validity gate, keeps lifecycle gates", () => {
    const { sql, params } = buildBaseWhere({
      ...base,
      temporalMode: 'overlap_boost',
    });
    expect(sql).not.toContain('validFrom <= $asOf');
    expect(sql).not.toContain('validUntil > $asOf');
    expect(sql).toContain('retractedAt IS NONE OR retractedAt > $asOf');
    expect(sql).toContain("status != 'compacted'");
    expect(params.asOf).toEqual(base.asOf);
  });

  it("without asOf, 'overlap_boost' changes nothing (actual-now closure)", () => {
    const strict = buildBaseWhere({ ...base, asOf: null });
    const soft = buildBaseWhere({
      ...base,
      asOf: null,
      temporalMode: 'overlap_boost',
    });
    expect(soft.sql).toBe(strict.sql);
  });
});

describe('scoreRows temporal anchor (overlap factor via breakdown)', () => {
  const anchor = new Date('2023-06-01T00:00:00Z');
  const row = (validFrom?: string, validUntil?: string): FusedRow =>
    ({
      id: `knowledge_fact:${validFrom ?? 'none'}`,
      entityId: 'knowledge_entity:e1',
      predicate: 'status',
      object: 'x',
      confidence: 0.9,
      validFrom,
      validUntil,
      recordedAt: '2023-06-01T00:00:00Z',
      fusedScore: 1,
      stages: [],
    }) as unknown as FusedRow;
  const factorOf = (r: FusedRow): number | undefined =>
    scoreRows({
      rows: [r],
      now: anchor.getTime(),
      temporalAnchor: anchor,
    })[0]!.breakdown.temporalOverlap;

  it('interval containing the anchor → factor 1 (omitted)', () => {
    expect(
      factorOf(row('2023-01-01T00:00:00Z', '2024-01-01T00:00:00Z')),
    ).toBeUndefined();
    expect(factorOf(row('2023-01-01T00:00:00Z'))).toBeUndefined();
  });

  it('decays with distance, never below the floor', () => {
    const near = factorOf(row('2023-06-15T00:00:00Z'))!; // 14 days after
    const far = factorOf(row('2025-06-01T00:00:00Z'))!; // two years after
    expect(near).toBeLessThan(1);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(0.25);
    expect(far).toBeLessThan(0.3);
  });

  it('expired interval decays from validUntil', () => {
    const recentlyExpired = factorOf(
      row('2022-01-01T00:00:00Z', '2023-05-01T00:00:00Z'), // ended 1 month before
    )!;
    expect(recentlyExpired).toBeLessThan(1);
    expect(recentlyExpired).toBeGreaterThan(0.7);
  });

  it('no validFrom → neutral (omitted)', () => {
    expect(factorOf(row(undefined))).toBeUndefined();
  });

  it('in-interval facts outrank distant ones under an anchor', () => {
    const scored = scoreRows({
      rows: [row('2023-05-01T00:00:00Z'), row('2025-06-01T00:00:00Z')],
      now: anchor.getTime(),
      temporalAnchor: anchor,
    });
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it('no anchor → factor absent regardless of interval', () => {
    const scored = scoreRows({
      rows: [row('2025-06-01T00:00:00Z')],
      now: anchor.getTime(),
    });
    expect(scored[0]!.breakdown.temporalOverlap).toBeUndefined();
  });
});

describe('profile temporalMode resolution', () => {
  const saved = process.env.RETRIEVAL_TEMPORAL_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.RETRIEVAL_TEMPORAL_MODE;
    else process.env.RETRIEVAL_TEMPORAL_MODE = saved;
  });

  it("defaults to 'filter'; env and per-tenant overrides win", () => {
    delete process.env.RETRIEVAL_TEMPORAL_MODE;
    expect(resolveRetrievalProfileFor('co_x').temporalMode).toBe('filter');
    process.env.RETRIEVAL_TEMPORAL_MODE = 'overlap_boost';
    expect(resolveRetrievalProfileFor('co_x').temporalMode).toBe(
      'overlap_boost',
    );
    const profile = resolveRetrievalProfileFor('co_y', {
      ...process.env,
      RETRIEVAL_TEMPORAL_MODE: 'filter',
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        co_y: { temporalMode: 'overlap_boost' },
      }),
    });
    expect(profile.temporalMode).toBe('overlap_boost');
  });
});
