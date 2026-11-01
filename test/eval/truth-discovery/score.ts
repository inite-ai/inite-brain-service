/**
 * Exact metrics for the truth-discovery battery. Each method is scored on
 * the contested slots no user anchored: an anchored claim is right by
 * construction and would flatter every method equally.
 */
import { discoverTruth, type TruthResult } from '../../../src/ai/calibration/truth-discovery';
import type { SimWorkspace } from './simulate';

export interface BatteryScore {
  /** Contested, unanchored slots scored. */
  slots: number;
  /** Share of slots where the method's pick is the true value (ties split). */
  accuracy: { truthDiscovery: number; majority: number };
  /** Expected calibration error of the fact posteriors (10 bins). */
  ece: number;
  /** RMSE of estimated vs real accuracy over the independent sources. */
  sourceRmse: { truthDiscovery: number; winRate: number };
  /** The never-wrong source that reports changes: its estimated accuracy. */
  diligent: { truthDiscovery: number | null; winRate: number | null };
}

export function score(ws: SimWorkspace, priorStrength: number): BatteryScore {
  const result = discoverTruth(ws.facts, ws.anchors, { priorStrength });
  const posterior = new Map(result.facts.map((f) => [f.factId, f.posterior]));
  const anchored = new Set(
    ws.anchors.map((a) => ws.facts.find((f) => f.factId === a.factId)!.slot),
  );

  let slots = 0;
  let tdRight = 0;
  let majorityRight = 0;
  const calibration: Array<{ p: number; right: boolean }> = [];
  for (const [slot, truth] of ws.truth) {
    const window = ws.facts.filter((f) => f.slot === slot && f.validUntil === null);
    const claims = [...new Set(window.map((f) => f.claim))];
    if (claims.length < 2 || anchored.has(slot)) continue;
    slots++;
    // Truth discovery: the claim with the highest posterior.
    const best = new Map<string, number>();
    for (const f of window) best.set(f.claim, posterior.get(f.factId) ?? 0);
    tdRight += splitCredit(best, truth);
    for (const [claim, p] of best) calibration.push({ p, right: claim === truth });
    // Majority: one vote per origin, the same deduplication truth discovery gets.
    const votes = new Map<string, number>();
    const seen = new Set<string>();
    for (const f of window) {
      const key = `${f.origin}|${f.claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      votes.set(f.claim, (votes.get(f.claim) ?? 0) + 1);
    }
    majorityRight += splitCredit(votes, truth);
  }

  const independent = ws.sources.filter((s) => s.kind === 'independent');
  const winRate = winRates(ws);
  const tdGlobal = (key: string) =>
    result.sources.find((s) => s.sourceKey === key && s.domain === null)?.accuracy ?? null;
  return {
    slots,
    accuracy: { truthDiscovery: tdRight / slots, majority: majorityRight / slots },
    ece: expectedCalibrationError(calibration),
    sourceRmse: {
      truthDiscovery: rmse(independent.map((s) => [tdGlobal(s.key), s.accuracy])),
      winRate: rmse(independent.map((s) => [winRate.get(s.key) ?? null, s.accuracy])),
    },
    diligent: {
      truthDiscovery: tdGlobal('diligent:recorder'),
      winRate: winRate.get('diligent:recorder') ?? null,
    },
  };
}

export function run(ws: SimWorkspace, priorStrength: number): TruthResult {
  return discoverTruth(ws.facts, ws.anchors, { priorStrength });
}

/** 1 if the truth is the unique top, 1/n if it ties n ways, else 0. */
function splitCredit(scores: Map<string, number>, truth: string): number {
  const top = Math.max(...scores.values());
  const tied = [...scores].filter(([, v]) => Math.abs(v - top) < 1e-12).map(([c]) => c);
  return tied.includes(truth) ? 1 / tied.length : 0;
}

/**
 * The win/loss refit as it stood (calibration-refit-runner `buildTrustEvents`):
 * an active fact is a win, a superseded one a loss, a competing one neither.
 */
function winRates(ws: SimWorkspace): Map<string, number> {
  const tally = new Map<string, { w: number; l: number }>();
  for (const f of ws.facts) {
    const t = tally.get(f.sourceKey) ?? { w: 0, l: 0 };
    const s = ws.status.get(f.factId);
    if (s === 'active') t.w++;
    else if (s === 'superseded') t.l++;
    tally.set(f.sourceKey, t);
  }
  const out = new Map<string, number>();
  for (const [k, { w, l }] of tally) if (w + l > 0) out.set(k, w / (w + l));
  return out;
}

function expectedCalibrationError(points: Array<{ p: number; right: boolean }>): number {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, right: 0 }));
  for (const { p, right } of points) {
    const b = bins[Math.min(9, Math.floor(p * 10))]!;
    b.n++;
    b.p += p;
    b.right += right ? 1 : 0;
  }
  const total = points.length || 1;
  return bins.reduce(
    (sum, b) => (b.n ? sum + (b.n / total) * Math.abs(b.p / b.n - b.right / b.n) : sum),
    0,
  );
}

function rmse(pairs: Array<[number | null, number]>): number {
  const known = pairs.filter((p): p is [number, number] => p[0] !== null);
  if (known.length === 0) return NaN;
  return Math.sqrt(known.reduce((s, [a, b]) => s + (a - b) ** 2, 0) / known.length);
}
