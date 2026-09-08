import type { ReadinessReport } from '../common/health.service';

/**
 * Capability probes — the ACTIVE half of "is this capability alive".
 *
 * ── The failure class ────────────────────────────────────────────────────
 * Three incidents in one week shared one shape: **the service reported
 * healthy while a whole capability was dead.**
 *
 *   1. The scoped pool went anonymous ~59 minutes after boot (#502). Every
 *      caller-facing read failed; `/health` stayed green because `version()`
 *      — what `ping()` calls — is answered for anonymous sessions too.
 *   2. `/ready` reported ready during embedder warmup (#503) because it
 *      ORed in an always-ready fallback provider, so the rollout playbook's
 *      "reindex once /ready is 200" gate never held.
 *   3. `POST /v1/ingest/mention` 400'd for six days from a two-flag
 *      interaction (#510) and nothing noticed.
 *
 * The common property is a **green signal that does not exercise the thing
 * it claims to cover.** #502 and #503 fixed the signals; both fixes landed
 * in `/ready`, which is polled at DEPLOY time and then never again. A pool
 * that lapses 59 minutes after a successful deploy is invisible to a
 * deploy-time gate by construction.
 *
 * So these probes RUN the capability on a timer and publish what happened.
 * Two rules follow from the incidents and are load-bearing:
 *
 *   - **A probe asserts an observable property of the OUTPUT, never the
 *     component's own opinion of itself.** #503's `/ready` was wrong
 *     precisely because it asked "does something think it can answer".
 *     The embed probe therefore measures the WIDTH of a vector the
 *     embedder actually produced, not `isReady()`.
 *   - **A probe must not be answerable from cache**, or it decays into the
 *     same green-that-proves-nothing (hence `embedUncached`).
 *
 * ── How far this generalises (deliberately not a framework) ──────────────
 * `CAPABILITY_COVERAGE` below ties each probe to the readiness checks it
 * continuously exercises, and `keyof ReadinessReport` makes that link a
 * COMPILE error if a check is renamed (test/capability-probe.unit-spec.ts
 * fails if one is ADDED without a probe). That is the whole generalisation:
 * the service's own readiness contract — three checks — must have a
 * continuous counterpart. Enumerating every "capability" brain claims (145
 * flags, every route) and asserting each is exercised by something is NOT
 * built here: that inventory is what per-surface flag-set specs (#510) and
 * the e2e suite are for, and a registry nobody can keep honest is another
 * green signal that proves nothing.
 */

/** The checks `/ready` reports, minus its own roll-up field. */
export type ReadinessCheck = Exclude<keyof ReadinessReport, 'ready'>;

export const CAPABILITY_NAMES = ['scoped_read', 'embed'] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * Probe outcomes. Bounded on purpose — this is a metric label, and the
 * whole series set is (capabilities × outcomes), not (× tenants).
 *
 *   serving      — exercised end to end and produced the expected result.
 *   unauthorized — ALIVE but refused: the session can no longer authorize
 *                  (incident 1's exact state).
 *   degraded     — answered, but with the wrong property: a vector in a
 *                  space the corpus is not in (incident 2's exact state).
 *   busy         — could not be exercised because the resource was
 *                  saturated. NOT A FAILURE — see `isConclusive`.
 *   error        — anything else: DB unreachable, statement threw, the
 *                  probe's own deadline expired.
 *   skipped      — nothing to exercise (no tenant in the roster, no
 *                  embedder in this process). Also not a failure.
 */
export const PROBE_OUTCOMES = [
  'serving',
  'unauthorized',
  'degraded',
  'busy',
  'error',
  'skipped',
] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

export interface ProbeReport {
  capability: CapabilityName;
  outcome: ProbeOutcome;
  /** Operator-facing specifics: which pool, which tenant, what the DB said. */
  detail?: string;
}

/**
 * Which readiness checks each probe continuously exercises.
 *
 * `scoped_read` covers `dbOk` as well as `scopedOk` because it cannot pass
 * without a reachable database — deliberately NOT a separate root-`ping()`
 * probe, which would be exactly the version()-answers-anonymously signal
 * that started all this.
 */
export const CAPABILITY_COVERAGE: Record<CapabilityName, readonly ReadinessCheck[]> = {
  scoped_read: ['dbOk', 'scopedOk'],
  embed: ['embedderReady'],
};

/**
 * A CONCLUSIVE outcome carries information about the capability's health;
 * an inconclusive one carries information about the probe. Only conclusive
 * outcomes move the up/down gauge — which is how "a saturated pool must not
 * page anyone" is enforced in the metric itself rather than in the alert
 * threshold, matching the same distinction `pingScoped()` makes in
 * readiness (#502): a busy pool is answering, it is just not answering US.
 */
export function isConclusive(outcome: ProbeOutcome): boolean {
  return outcome !== 'busy' && outcome !== 'skipped';
}

/**
 * Pool saturation, verbatim from `SurrealService.acquireWithTimeout`:
 * "Surreal scoped pool acquire timed out after 10000ms (pool=…, waiters=…)".
 */
const BUSY = /pool acquire timed out/i;

/**
 * Authorization refusals. The first two are what SurrealDB answers an
 * anonymous session (incident 1); the third is brain's own fail-closed
 * wrapper when the scoped signin cannot be renewed at all — a rotated
 * secret or a dropped `brain_caller` — which is the same operator problem
 * with a different first line.
 */
const UNAUTHORIZED =
  /Anonymous access not allowed|Not enough permissions|IAM error|scoped DB signin unavailable|Invalid credentials|There was a problem with authentication/i;

/**
 * Classify a thrown probe failure. Order matters: saturation is checked
 * FIRST, because an acquire timeout says nothing about whether the pool
 * could have authorized — reporting it as a failure is how a load spike
 * turns into a page.
 */
export function classifyProbeFailure(error: unknown): 'unauthorized' | 'busy' | 'error' {
  const message = error instanceof Error ? error.message : String(error);
  if (BUSY.test(message)) return 'busy';
  if (UNAUTHORIZED.test(message)) return 'unauthorized';
  return 'error';
}

/** Short, greppable text for the operator; the runbook carries the rest. */
export function probeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
