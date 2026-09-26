/**
 * How available a processed memory is, from its history of use — the
 * base-level activation of ACT-R (Anderson & Schooler 1991: the need for a
 * memory follows a power law of the recency and frequency of its past use,
 * across newspaper headlines, speech to children and e-mail).
 *
 * Every event in a fact's history — it was written; an answer verifiably
 * used it (0107 outcome telemetry: verifier-supported, user-confirmed) —
 * leaves a trace that fades as a power of its age, `(1 + t/τ)^-d`, and the
 * fact is as available as the sum of its traces, capped at a fresh fact's.
 * So an old fact that keeps being used stays hot, a fact used once long
 * ago cools, and frequency and recency are one mechanism, not two knobs.
 * Retrieval that merely SURFACED a fact is not an event (it would feed
 * itself); raw text is never subject to this (docs/roadmap/raw-processing-
 * triggers-2026-09.md §4.3).
 *
 * Parameters: `d = 0.5`, the ACT-R default Anderson & Schooler fitted to
 * environmental need; the time scale τ comes from the predicate's own
 * half-life in the tenant registry, set so that an unused fact at one
 * half-life weighs exactly one half — the registry keeps its meaning, the
 * tail is heavier than the exponential it replaces. A predicate with no
 * half-life (a state, an instruction) does not fade.
 *
 * Only the last use's time is recorded, not every use's: the uses before
 * it are taken as spread evenly between the fact's creation and its last
 * use (Petrov 2006, the hybrid approximation of the base-level equation).
 * Pure.
 */

const DECAY = 0.5;

export interface ActivationInput {
  /** Days since the fact was written. */
  ageDays: number;
  /** The predicate's half-life in days (registry policy). */
  halfLifeDays: number;
  /** Verified uses (verified + confirmed), 0 or absent = none recorded. */
  uses?: number | undefined;
  /** Days since the last verified use, when recorded. */
  lastUseDays?: number | undefined;
  /** Days since the last retrieval (the legacy read-restarts-decay stamp, when attached). */
  lastReadDays?: number | undefined;
}

export function activationDecay(p: ActivationInput): number {
  const tau = p.halfLifeDays / 3;
  const trace = (t: number): number => (1 + Math.max(0, t) / tau) ** -DECAY;
  const age = Math.max(0, p.ageDays);
  let sum = trace(age);
  const uses = p.uses !== undefined && p.uses > 0 ? p.uses : p.lastUseDays !== undefined ? 1 : 0;
  if (uses > 0) {
    // The last use at its time (or, unrecorded, the uses spread over the
    // whole life); the earlier ones spread between creation and it.
    const last =
      p.lastUseDays === undefined ? undefined : Math.min(Math.max(0, p.lastUseDays), age);
    sum +=
      last === undefined
        ? uses * meanTrace(0, age, tau)
        : trace(last) + (uses - 1) * meanTrace(last, age, tau);
  }
  if (p.lastReadDays !== undefined) sum += trace(Math.min(p.lastReadDays, age));
  return Math.min(1, sum);
}

/** The mean of `(1 + t/τ)^-d` over t ∈ [a, b] — closed form. */
function meanTrace(a: number, b: number, tau: number): number {
  if (b - a < 1e-9) return (1 + a / tau) ** -DECAY;
  const f = (t: number): number => (1 + t / tau) ** (1 - DECAY);
  return (tau * (f(b) - f(a))) / ((1 - DECAY) * (b - a));
}
