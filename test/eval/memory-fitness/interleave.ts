/**
 * Round-robin candidate interleave for the memory-fitness provenance
 * walk (runner.ts, d3): candidates used to be flattened hit-major then
 * sliced, so one fat entity (many facts on the first hit) monopolised
 * the whole walk budget and the fact holding the seeded fragment —
 * often on hit 2 or 3 — never got walked. Interleaving takes the first
 * fact of EVERY hit, then the second of every hit, and so on
 * (hit1.fact1, hit2.fact1, hit3.fact1, hit1.fact2, …) before the cap,
 * so the budget spreads across entities.
 *
 * Pure and harness-only — no server behavior involved.
 */
export function interleaveRoundRobin<T>(lists: ReadonlyArray<readonly T[]>, cap: number): T[] {
  const out: T[] = [];
  if (cap <= 0) return out;
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      if (rank >= list.length) continue;
      out.push(list[rank] as T);
      if (out.length >= cap) return out;
    }
  }
  return out;
}
