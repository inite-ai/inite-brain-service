import { envFlagNotDisabled } from './env-validation';

/**
 * Predicate identity adjudication — PREDICATE_IDENTITY_JUDGE.
 *
 * `canonicalize()` decides whether a coined predicate is a new attribute
 * or a new NAME for one the graph already has. It used to decide that by
 * cosine alone, against the ACTIVE seed set only — so one attribute
 * scattered across many slots (`deploy_target`, `deploys_to`, `deploys`
 * for one thing; `queue_backend` beside `job_queue_backend`), nothing
 * superseded across two predicates, and every fragment kept its own
 * value active forever.
 *
 * When on, a sub-threshold coinage is shortlisted by cosine over the
 * coined vocabulary as well as the seeds, and an LLM decides whether one
 * of those names the same attribute — because the measurement says no
 * cosine threshold can: on a live 196-predicate registry, cosine ranks
 * `retry_policy`~`retry_attempts` (two fields) ABOVE
 * `pilot_launch_date`~`changed_launch_date` (one field), under every
 * embedding text tried. Same-attribute recall on the measured set was
 * 9/9 with zero false merges.
 *
 * ON by default: the judge only ever adds an alias where it is
 * confident, every failure path resolves to today's propose-a-new-slot
 * behaviour, and a deployment that has no OpenAI key never calls it at
 * all. The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Cleared (`0`) ⇒ cosine-only canonicalization,
 * byte-identical to the pre-judge behaviour.
 */
export function predicateIdentityJudgeEnabled(): boolean {
  return envFlagNotDisabled(process.env.PREDICATE_IDENTITY_JUDGE);
}
