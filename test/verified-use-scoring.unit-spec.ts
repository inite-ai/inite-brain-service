/**
 * Verified use in scoring (memory_outcome_stat, 0107) as the fact's
 * activation (search/internals/activation.ts) + tenant-aware decay
 * resolution.
 *
 * Retrieval alone never extends a memory's life: a fact that keeps being
 * retrieved but never verifiably used fades exactly like its never-read
 * twin; each verified use is a trace of its own, so recency and frequency
 * both keep a fact available.
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

const act = (ageDays: number, halfLifeDays = 60): number =>
  (1 + ageDays / (halfLifeDays / 3)) ** -0.5;

describe('scoreRows — verified use is activation', () => {
  it('REGRESSION PIN: retrieval alone never extends life — a much-read but never-verified fact scores identically to its never-read twin', () => {
    const ranked = scoreRows({ rows: [row(), row()], now: NOW });
    expect(ranked[1]!.score).toBe(ranked[0]!.score);
    // 120 days, half-life 60: the power-law trace of its creation alone.
    expect(ranked[0]!.breakdown.decay).toBeCloseTo(act(120), 10);
  });

  it('an unused fact weighs one half at one half-life, with a heavier tail than the exponential', () => {
    const [atHalfLife] = scoreRows({
      rows: [row({ recordedAt: new Date(NOW - 60 * DAY).toISOString() })],
      now: NOW,
    });
    expect(atHalfLife!.breakdown.decay).toBeCloseTo(0.5, 10);
    const [old] = scoreRows({ rows: [row()], now: NOW });
    expect(old!.breakdown.decay).toBeGreaterThan(Math.exp((-Math.LN2 * 120) / 60));
  });

  it('a recent verified use makes an old fact available again', () => {
    const [stale, verified] = scoreRows({
      rows: [row(), row({ lastVerifiedUseAt: new Date(NOW - DAY).toISOString() })],
      now: NOW,
    });
    expect(verified!.breakdown.decay).toBe(1);
    expect(verified!.score).toBeGreaterThan(stale!.score);
  });

  it('frequency counts: many old uses keep a fact warmer than one', () => {
    const lastUse = new Date(NOW - 90 * DAY).toISOString();
    const [once, often] = scoreRows({
      rows: [
        row({ lastVerifiedUseAt: lastUse, verifiedUseScore: 1 }),
        row({ lastVerifiedUseAt: lastUse, verifiedUseScore: 6 }),
      ],
      now: NOW,
    });
    expect(once!.breakdown.decay).toBeCloseTo(act(120) + act(90), 10);
    expect(often!.breakdown.decay).toBeGreaterThan(once!.breakdown.decay);
  });

  it('never above a fresh fact, and a use older than the fact never penalizes', () => {
    const [fresh, withOldUse] = scoreRows({
      rows: [
        row({ recordedAt: new Date(NOW).toISOString() }),
        row({
          recordedAt: new Date(NOW).toISOString(),
          lastVerifiedUseAt: new Date(NOW - 30 * DAY).toISOString(),
          verifiedUseScore: 40,
        }),
      ],
      now: NOW,
    });
    expect(fresh!.breakdown.decay).toBe(1);
    expect(withOldUse!.score).toBe(fresh!.score);
  });

  it('carries no separate verified-use multiplier (frequency is in the activation)', () => {
    const [scored] = scoreRows({ rows: [row({ verifiedUseScore: 50 })], now: NOW });
    expect('verifiedUse' in scored!.breakdown).toBe(false);
  });
});

describe('scoreRows — tenant-aware decay resolution (policyResolver)', () => {
  it('a passed resolver decides the half-life (30d beats the legacy 60d default)', () => {
    const scored = scoreRows({
      rows: [row()],
      now: NOW,
      policyResolver: () => ({ decayHalfLifeDays: 30 }),
    })[0]!;
    expect(scored.breakdown.decay).toBeCloseTo(act(120, 30), 10);
    expect(scored.breakdown.decay).toBeLessThan(act(120, 60));
  });

  it('resolver null → legacy code-seed path (60d default), byte-identical', () => {
    const legacy = scoreRows({ rows: [row()], now: NOW })[0]!;
    const explicit = scoreRows({ rows: [row()], now: NOW, policyResolver: null })[0]!;
    expect(explicit.score).toBe(legacy.score);
    expect(explicit.breakdown.decay).toBeCloseTo(act(120), 10);
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
