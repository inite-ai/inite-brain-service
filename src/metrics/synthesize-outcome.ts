/**
 * The `outcome` label of `brain_synthesize_total` — terminal exits plus the
 * intermediate markers (`generator_truncated`, `search_loop_refined`,
 * `revised`) that ride beside them. Split out of metrics.service.ts (file
 * budget). src/mri/economics.ts lists the terminal subset.
 */
export type SynthesizeOutcome =
  | 'ok'
  | 'no_results'
  | 'no_grounded_evidence'
  // V9 §4: the memory-coverage abstention floor fired.
  | 'low_coverage'
  | 'verifier_partial'
  | 'verifier_failed'
  | 'generator_error'
  | 'harness_mode'
  | 'model_budget'
  // The generator hit the token cap and the partial answer was
  // salvaged (audit W5 #24) — distinct from generator_error, which
  // means we returned nothing at all.
  | 'generator_truncated'
  // V13 constrained search loop: the one refine round ran (the
  // final outcome is still counted separately by the exits above).
  | 'search_loop_refined'
  // The revision round ran on a partial verdict (revise-round.ts);
  // the final outcome is still counted by the exits above.
  | 'revised'
  | 'verifier_error'
  // #945: the provider refused the generator or the verifier.
  | 'model_unavailable';
