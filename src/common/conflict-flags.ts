import { envFlagEnabled } from './env-validation';

/**
 * Direct-fact conflict semantics — CONFLICT_DIRECT_FACT_SLOT.
 *
 * A predicate absent from the registry resolves to DEFAULT_FALLBACK
 * (`__default__`, semantics 'append_only') — correct for the
 * open-vocabulary mention bulk, but on the TYPED direct path
 * (record_fact / POST /v1/ingest/fact) it short-circuits
 * fn::resolve_fact's conflict pool to `[]`: two direct writes with the
 * same (entity, predicate) and contradicting objects both land
 * INSERTED and no conflict is ever formed or surfaced.
 *
 * When on, FactResolverService promotes JUST that combination — direct
 * path (recordOutcomeMetric) AND registry-default predicate — to
 * 'bitemporal': the margin doctrine, i.e. close-scored contradictions
 * become COMPETING and a clear winner SUPERSEDES. Deliberately NOT
 * 'single_active': its resolver branch supersedes unconditionally
 * (0085 `$supersede = $semantics = 'single_active' OR …`) and can
 * never surface a COMPETING pair. DEFAULT_FALLBACK itself is untouched
 * (load-bearing for mention extraction), as is every known predicate's
 * registry policy. The env read lives here in the common layer
 * (engine-gates S5.2), read at call time so a flip is runtime-mutable.
 * Default off ⇒ append_only passthrough, byte-identical. CONFLICT_
 * sits off the ENGINE flag budget by design (a resolver-policy knob
 * family — cfg weights/thresholds — not an engine fork).
 */
export function conflictDirectFactSlotEnabled(): boolean {
  return envFlagEnabled(process.env.CONFLICT_DIRECT_FACT_SLOT);
}
