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

/**
 * Mention-path conflict semantics — CONFLICT_MENTION_FACT_SLOT.
 *
 * The mention/extraction path resolves a canonicalized predicate to its
 * registry policy; for a single-value slot that policy is
 * 'single_active', whose resolver branch supersedes UNCONDITIONALLY
 * (0085 `$supersede = $semantics = 'single_active' OR …`) and can never
 * surface a COMPETING pair. Two conversations asserting contradictory
 * values of one (userId, entity, predicate) slot therefore never form a
 * conflict — the second assertion silently replaces the first and
 * serving picks one side (state-transitions s07).
 *
 * When on, FactResolverService promotes JUST that combination — mention
 * path (no recordOutcomeMetric) AND registry semantics 'single_active'
 * — to 'bitemporal': the SAME conflict-slot doctrine the direct path
 * uses (close-scored contradictions become COMPETING, both linked; a
 * clear winner still SUPERSEDES; an equal value from a different origin
 * CORROBORATES — the fn's exact `object = $object` check, no fuzzier
 * matching). Candidates stay scope-local (0055: fn::resolve_fact
 * filters by $user_id), so different users never collide. The
 * append_only bulk and DEFAULT_FALLBACK are untouched (load-bearing for
 * open-vocabulary mention extraction), as is the direct typed path. The
 * env read lives here in the common layer (engine-gates S5.2), read at
 * call time so a flip is runtime-mutable. Default off ⇒ registry
 * passthrough, byte-identical. CONFLICT_ sits off the ENGINE flag
 * budget by design (a resolver-policy knob family — cfg
 * weights/thresholds — not an engine fork).
 */
export function conflictMentionFactSlotEnabled(): boolean {
  return envFlagEnabled(process.env.CONFLICT_MENTION_FACT_SLOT);
}
