/**
 * Synthetic workspaces for the truth-discovery battery (#847): sources of
 * known accuracy claim values for slots of known truth, so every metric is
 * exact and nothing needs a judge.
 *
 * Three kinds of source:
 *  - independent: names the truth with its accuracy, else a random wrong value;
 *  - copier: repeats one independent source's claim under the SAME origin
 *    (a document ingested twice, a forwarded message), the case copy
 *    detection by `originKey` exists for;
 *  - diligent: reports a change of value as two facts that succeed each
 *    other in valid time. It is never wrong; the win/loss refit scored
 *    every superseded fact as a loss, so it looked unreliable.
 *
 * Seeded (mulberry32): the same seed builds the same workspace.
 */
import type { TruthAnchor, TruthFact } from '../../../src/ai/calibration/truth-discovery';

export interface SimSource {
  key: string;
  accuracy: number;
  kind: 'independent' | 'copier' | 'diligent';
}

export interface SimWorkspace {
  facts: TruthFact[];
  anchors: TruthAnchor[];
  sources: SimSource[];
  /** slot → the true value over the contested window. */
  truth: Map<string, string>;
  /** factId → status the write path would leave it in (for the win/loss baseline). */
  status: Map<string, 'active' | 'superseded' | 'competing'>;
}

export interface SimOptions {
  seed: number;
  slots: number;
  /** Distinct values a slot's claims are drawn from. */
  values: number;
  /** Fraction of contested facts a user confirmed or rejected. */
  anchorRate: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

export function simulate(options: SimOptions): SimWorkspace {
  const rnd = mulberry32(options.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const independent: SimSource[] = [0.95, 0.9, 0.8, 0.7, 0.6, 0.55, 0.35].map((accuracy, i) => ({
    key: `src${i}:recorder`,
    accuracy,
    kind: 'independent',
  }));
  // The copiers repeat the WORST source: without copy detection its wrong
  // answers would outvote the good sources.
  const worst = independent[independent.length - 1]!;
  const copiers: SimSource[] = [0, 1].map((i) => ({
    key: `copy${i}:recorder`,
    accuracy: worst.accuracy,
    kind: 'copier',
  }));
  const diligent: SimSource = { key: 'diligent:recorder', accuracy: 1, kind: 'diligent' };
  const sources = [...independent, ...copiers, diligent];

  const facts: TruthFact[] = [];
  const anchors: TruthAnchor[] = [];
  const truth = new Map<string, string>();
  const status = new Map<string, 'active' | 'superseded' | 'competing'>();
  let n = 0;
  const id = () => `f${n++}`;
  const values = Array.from({ length: options.values }, (_, i) => `v${i}`);

  for (let s = 0; s < options.slots; s++) {
    const slot = `slot${s}`;
    const domain = `pred${s % 3}`;
    const from = T0 + s * DAY;
    // The diligent source reports a change first: the old value until
    // `from`, then the slot's current value. Only the current window is
    // contested; the old value is history, not a rival.
    const current = pick(values);
    truth.set(slot, current);
    if (rnd() < 0.5) {
      const old = pick(values.filter((v) => v !== current));
      const oldId = id();
      facts.push({
        factId: oldId,
        slot,
        claim: old,
        sourceKey: diligent.key,
        domain,
        origin: `o-${oldId}`,
        validFrom: from - 30 * DAY,
        validUntil: from,
      });
      status.set(oldId, 'superseded');
      const newId = id();
      facts.push({
        factId: newId,
        slot,
        claim: current,
        sourceKey: diligent.key,
        domain,
        origin: `o-${newId}`,
        validFrom: from,
        validUntil: null,
      });
      status.set(newId, 'active');
    }
    const voters = independent.filter(() => rnd() < 0.5);
    if (voters.length < 2) voters.push(...independent.slice(0, 2 - voters.length));
    const claimed = new Map<string, { claim: string; origin: string }>();
    for (const src of voters) {
      const right = rnd() < src.accuracy;
      const claim = right ? current : pick(values.filter((v) => v !== current));
      const fid = id();
      const origin = `o-${fid}`;
      claimed.set(src.key, { claim, origin });
      facts.push({
        factId: fid,
        slot,
        claim,
        sourceKey: src.key,
        domain,
        origin,
        validFrom: from,
        validUntil: null,
      });
    }
    const copied = claimed.get(worst.key);
    if (copied) {
      for (const copier of copiers) {
        const fid = id();
        facts.push({
          factId: fid,
          slot,
          claim: copied.claim,
          sourceKey: copier.key,
          domain,
          origin: copied.origin,
          validFrom: from,
          validUntil: null,
        });
      }
    }
    const window = facts.filter((f) => f.slot === slot && f.validUntil === null);
    const contested = new Set(window.map((f) => f.claim)).size > 1;
    for (const f of window) {
      status.set(f.factId, contested ? 'competing' : 'active');
      if (contested && rnd() < options.anchorRate) {
        anchors.push({ factId: f.factId, correct: f.claim === current });
      }
    }
  }
  return { facts, anchors, sources, truth, status };
}
