/**
 * Verified-use successor signals in scoring (memory_outcome_stat, 0107 —
 * Brain v2 review gap #7) + tenant-aware decay resolution.
 *
 * THE regression this wave exists for: under the legacy usage signals,
 * retrieval alone extends a memory's life (lastReadAt restarts the decay
 * clock on every surfacing). Under verifiedUseDecay the anchor moves
 * ONLY on a verified use — a fact that keeps being retrieved but never
 * verified decays exactly like its never-read twin.
 *
 * Deterministic harness cloned from usage-decay.unit-spec.ts: the probe
 * predicate is absent from CORE_PREDICATES so legacy policyFor falls
 * back to DEFAULT_POLICY (half-life 60 days).
 */
import { scoreRows } from '../src/search/internals/scoring';
import type { FactRow } from '../src/search/internals/types';

type FusedRow = FactRow & { fusedScore: number };

const NOW = Date.parse('2026-07-09T00:00:00Z');
const DAY = 86_400_000;

function row(over: Partial<FusedRow> = {}): FusedRow {
  return {
    id: 'knowledge_fact:x',
    entityId: 'knowledge_entity:e',
    predicate: 'verified_use_probe_pred',
    object: 'value',
    confidence: 0.9,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: new Date(NOW - 120 * DAY).toISOString(),
    status: 'active',
    source: { vertical: 'rent' },
    fusedScore: 1,
    ...over,
  } as FusedRow;
}

describe('scoreRows — verified-use decay anchor', () => {
  it('REGRESSION PIN: retrieval alone never extends life — a much-read but never-verified fact scores identically to its never-read twin', () => {
    // verifiedUseDecay=on / legacy decay=off at the pipeline level means:
    // lastReadAt is NOT attached (legacy enrichment off) and
    // lastVerifiedUseAt is absent (no verified use recorded). Scoring is
    // attachment-driven, so the 120-day-old fact decays from recordedAt
    // exactly like the twin — 0.25 at half-life 60.
    const ranked = scoreRows({ rows: [row(), row()], now: NOW });
    const neverRead = ranked[0]!;
    const muchReadNeverVerified = ranked[1]!;
    expect(muchReadNeverVerified.score).toBe(neverRead.score);
    expect(muchReadNeverVerified.breakdown.decay).toBeCloseTo(0.25, 2);
  });

  it('an attached lastVerifiedUseAt moves the decay anchor', () => {
    const ranked = scoreRows({
      rows: [row(), row({ lastVerifiedUseAt: new Date(NOW - DAY).toISOString() })],
      now: NOW,
    });
    const stale = ranked[0]!;
    const verified = ranked[1]!;
    expect(stale.breakdown.decay).toBeCloseTo(0.25, 2);
    expect(verified.breakdown.decay).toBeGreaterThan(0.95);
    expect(verified.score).toBeGreaterThan(stale.score);
  });

  it('a lastVerifiedUseAt older than recordedAt never penalizes', () => {
    const ranked = scoreRows({
      rows: [
        row({ recordedAt: new Date(NOW).toISOString() }),
        row({
          recordedAt: new Date(NOW).toISOString(),
          lastVerifiedUseAt: new Date(NOW - 30 * DAY).toISOString(),
        }),
      ],
      now: NOW,
    });
    expect(ranked[1]!.score).toBe(ranked[0]!.score);
  });

  it('both anchors attached → monotone max of the two', () => {
    const readTs = new Date(NOW - 10 * DAY).toISOString();
    const verifiedTs = new Date(NOW - DAY).toISOString();
    const [readOnly, verifiedOnly, both] = scoreRows({
      rows: [
        row({ lastReadAt: readTs }),
        row({ lastVerifiedUseAt: verifiedTs }),
        row({ lastReadAt: readTs, lastVerifiedUseAt: verifiedTs }),
      ],
      now: NOW,
    });
    // The joint anchor equals the fresher of the two (verified, 1d ago).
    expect(both!.breakdown.decay).toBe(verifiedOnly!.breakdown.decay);
    expect(both!.breakdown.decay).toBeGreaterThan(readOnly!.breakdown.decay);
  });
});

describe('scoreRows — verified-use ranking factor', () => {
  it('beta 0 → factor exactly 1.0 and no breakdown fragment, score present or not', () => {
    const rows = [row(), row({ verifiedUseScore: 50 })];
    const base = scoreRows({ rows, now: NOW });
    const flagged = scoreRows({ rows, now: NOW, verifiedUseBeta: 0 });
    expect(flagged.map((s) => s.score)).toEqual(base.map((s) => s.score));
    for (const s of [...base, ...flagged]) {
      expect(s.breakdown.verifiedUse).toBeUndefined();
    }
  });

  it('score 0 / absent is factor exactly 1 at ANY beta (no breakdown)', () => {
    const ranked = scoreRows({
      rows: [row(), row({ verifiedUseScore: 0 })],
      now: NOW,
      verifiedUseBeta: 5,
    });
    const baseline = scoreRows({ rows: [row()], now: NOW })[0]!;
    expect(ranked[0]!.score).toBe(baseline.score);
    expect(ranked[1]!.score).toBe(baseline.score);
    expect(ranked[0]!.breakdown.verifiedUse).toBeUndefined();
    expect(ranked[1]!.breakdown.verifiedUse).toBeUndefined();
  });

  it('a verified fact outranks its identical never-verified twin, with the "because" fragment', () => {
    const ranked = scoreRows({
      rows: [row({ verifiedUseScore: 4 }), row()],
      now: NOW,
      verifiedUseBeta: 0.5,
    });
    const verified = ranked[0]!;
    const plain = ranked[1]!;
    expect(verified.score).toBeGreaterThan(plain.score);
    expect(verified.breakdown.verifiedUse).toMatchObject({ count: 4 });
    expect(verified.breakdown.verifiedUse!.factor).toBeGreaterThan(1);
    // The factor is exactly the multiplier applied to finalScore.
    expect(verified.breakdown.finalScore).toBeCloseTo(
      plain.breakdown.finalScore * verified.breakdown.verifiedUse!.factor,
      10,
    );
  });

  it('saturation caps the boost: factor never exceeds 1 + beta', () => {
    const beta = 0.5;
    const ranked = scoreRows({
      rows: [row({ verifiedUseScore: 10 }), row({ verifiedUseScore: 100_000 })],
      now: NOW,
      verifiedUseBeta: beta,
      verifiedUseSaturation: 10,
    });
    expect(ranked[0]!.breakdown.verifiedUse!.factor).toBeCloseTo(1 + beta, 5);
    expect(ranked[1]!.breakdown.verifiedUse!.factor).toBeCloseTo(1 + beta, 10);
    expect(ranked[1]!.breakdown.verifiedUse!.factor).toBeLessThanOrEqual(1 + beta);
  });
});

describe('scoreRows — tenant-aware decay resolution (policyResolver)', () => {
  it('a passed resolver decides the half-life (30d beats the legacy 60d default)', () => {
    const scored = scoreRows({
      rows: [row()],
      now: NOW,
      policyResolver: () => ({ decayHalfLifeDays: 30 }),
    })[0]!;
    // 120 days at half-life 30 → 0.0625.
    expect(scored.breakdown.decay).toBeCloseTo(Math.exp((-Math.LN2 * 120) / 30), 10);
  });

  it('resolver null → legacy code-seed path (60d default), byte-identical', () => {
    const legacy = scoreRows({ rows: [row()], now: NOW })[0]!;
    const explicit = scoreRows({ rows: [row()], now: NOW, policyResolver: null })[0]!;
    expect(explicit.score).toBe(legacy.score);
    expect(explicit.breakdown.decay).toBeCloseTo(Math.exp((-Math.LN2 * 120) / 60), 10);
  });

  it('a registry miss falls back to the 60d default inside the resolver = legacy-identical', () => {
    // The registry resolver NEVER misses hard: policyFor(companyId, p)
    // falls back to seed/DEFAULT_FALLBACK (halfLife 60). Pin that a
    // resolver with that contract scores byte-identically to legacy for
    // an unknown predicate.
    const registryLike = (p: string): { decayHalfLifeDays: number | null } =>
      p === 'known_tenant_pred' ? { decayHalfLifeDays: 7 } : { decayHalfLifeDays: 60 };
    const legacy = scoreRows({ rows: [row()], now: NOW })[0]!;
    const viaResolver = scoreRows({ rows: [row()], now: NOW, policyResolver: registryLike })[0]!;
    expect(viaResolver.score).toBe(legacy.score);
  });

  it('resolves on the 0082 canonical alias, not the coined surface predicate', () => {
    const seen: string[] = [];
    const resolver = (p: string): { decayHalfLifeDays: number | null } => {
      seen.push(p);
      return { decayHalfLifeDays: 60 };
    };
    scoreRows({
      rows: [row({ predicate: 'coined_variant', predicateAlias: 'canonical_pred' })],
      now: NOW,
      policyResolver: resolver,
    });
    expect(seen).toEqual(['canonical_pred']);
  });

  it('null half-life from the resolver disables decay entirely', () => {
    const scored = scoreRows({
      rows: [row()],
      now: NOW,
      policyResolver: () => ({ decayHalfLifeDays: null }),
    })[0]!;
    expect(scored.breakdown.decay).toBe(1);
  });
});
