/**
 * Truth-discovery battery (#847). Mechanical and free: no stand, no model,
 * no judge. Synthetic workspaces of known truth (simulate.ts) are scored
 * exactly (score.ts).
 *
 * The prior strength is chosen on TUNE seeds and reported on EVAL seeds
 * it never saw, so the number below is not fitted to itself. The chosen
 * value is what src/ai/calibration/truth-discovery-pass.ts ships.
 *
 * Run: pnpm eval:truth-discovery
 */
import { simulate } from './simulate';
import { score, type BatteryScore } from './score';

const TUNE_SEEDS = [1, 2, 3, 4, 5];
const EVAL_SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
const GRID = [1, 2, 4, 8, 16, 32];
const SHAPE = { slots: 400, values: 4, anchorRate: 0.05 };

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function averaged(seeds: number[], strength: number) {
  const runs: BatteryScore[] = seeds.map((seed) => score(simulate({ seed, ...SHAPE }), strength));
  return {
    td: mean(runs.map((r) => r.accuracy.truthDiscovery)),
    majority: mean(runs.map((r) => r.accuracy.majority)),
    ece: mean(runs.map((r) => r.ece)),
    rmseTd: mean(runs.map((r) => r.sourceRmse.truthDiscovery)),
    rmseWin: mean(runs.map((r) => r.sourceRmse.winRate)),
    diligentTd: mean(runs.map((r) => r.diligent.truthDiscovery ?? NaN)),
    diligentWin: mean(runs.map((r) => r.diligent.winRate ?? NaN)),
    slots: mean(runs.map((r) => r.slots)),
  };
}

const tuned = GRID.map((strength) => ({ strength, ...averaged(TUNE_SEEDS, strength) })).sort(
  (a, b) => b.td - a.td || a.ece - b.ece,
);
const chosen = tuned[0]!.strength;
const result = averaged(EVAL_SEEDS, chosen);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

console.log('tune (accuracy by prior strength):');
for (const t of [...tuned].sort((a, b) => a.strength - b.strength)) {
  console.log(`  ${String(t.strength).padStart(3)}  td ${pct(t.td)}  ece ${t.ece.toFixed(3)}`);
}
console.log(
  `\neval on ${EVAL_SEEDS.length} unseen seeds, prior strength ${chosen}, ~${result.slots.toFixed(0)} contested slots each:`,
);
console.log(
  `  pick accuracy      truth discovery ${pct(result.td)}   majority vote ${pct(result.majority)}`,
);
console.log(`  calibration (ECE)  ${result.ece.toFixed(3)}`);
console.log(
  `  source RMSE        truth discovery ${result.rmseTd.toFixed(3)}   win/loss refit ${result.rmseWin.toFixed(3)}`,
);
console.log(
  `  diligent source (true accuracy 1.0)  truth discovery ${result.diligentTd.toFixed(2)}   win/loss refit ${result.diligentWin.toFixed(2)}`,
);
