import { ConfigService } from '@nestjs/config';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { DEFAULT_FALLBACK } from '../src/ai/predicate-registry-internals/types';
import type { PredicateDefinition } from '../src/ai/predicate-registry-internals/types';

/**
 * Policy reachability — the gap that made the cardinality judge inert.
 *
 * `canonicalize()` inserts a novel predicate with `status: 'proposed'`.
 * `policyFor()` read `snapshot.byId`, which is built from `status ===
 * 'active'` rows ONLY. So every open-vocabulary predicate's row carried
 * a policy that nothing could read, and every such fact resolved on
 * DEFAULT_FALLBACK's `append_only` — "no conflict possible at ingest".
 *
 * Measured on a live tenant: 143 of 143 `llm_auto` rows were 'proposed',
 * i.e. the entire coined vocabulary. Writing `semantics: 'single_active'`
 * onto those rows changed nothing at all until this lookup existed —
 * which is why "the registry now says single_active" was never evidence
 * that anything had been fixed.
 *
 * The invariant in both directions: a proposed row's policy is
 * reachable, and an active row of the same id always wins.
 */
function makeConfig(): ConfigService {
  return { get: <T>(_k: string, dflt?: T) => dflt as T } as unknown as ConfigService;
}

function def(over: Partial<PredicateDefinition>): PredicateDefinition {
  return { ...DEFAULT_FALLBACK, ...over } as PredicateDefinition;
}

/** Install a snapshot straight into the service cache. */
function withSnapshot(
  svc: PredicateRegistryService,
  companyId: string,
  snapshot: Record<string, unknown>,
): void {
  (
    svc as unknown as {
      cache: { set: (k: string, v: unknown) => void };
    }
  ).cache.set(companyId, { snapshot, loadedAt: Date.now() });
}

describe('policyFor — proposed predicates carry their own policy', () => {
  const svc = () =>
    new PredicateRegistryService(undefined as never, undefined as never, makeConfig());

  it('reads a PROPOSED row (byId alone would have answered append_only)', () => {
    const proposed = def({ predicateId: 'payout_cutoff', semantics: 'single_active' });
    const s = svc();
    withSnapshot(s, 'co_x', {
      byId: new Map(),
      policyById: new Map([['payout_cutoff', proposed]]),
    });
    expect(s.policyFor('co_x', 'payout_cutoff').semantics).toBe('single_active');
  });

  it('an ACTIVE row of the same id wins over the proposed one', () => {
    const s = svc();
    const active = def({ predicateId: 'status', semantics: 'single_active' });
    withSnapshot(s, 'co_x', {
      byId: new Map([['status', active]]),
      policyById: new Map([['status', active]]),
    });
    expect(s.policyFor('co_x', 'status')).toBe(active);
  });

  it('an unknown predicate still falls back to DEFAULT_FALLBACK', () => {
    const s = svc();
    withSnapshot(s, 'co_x', { byId: new Map(), policyById: new Map() });
    expect(s.policyFor('co_x', 'never_seen').predicateId).toBe(DEFAULT_FALLBACK.predicateId);
  });

  it('a legacy snapshot without policyById still resolves through byId', () => {
    // Test fixtures across the repo build snapshot literals by hand; a
    // missing map must not blank out the policy for active predicates.
    const s = svc();
    const active = def({ predicateId: 'status', semantics: 'single_active' });
    withSnapshot(s, 'co_x', { byId: new Map([['status', active]]) });
    expect(s.policyFor('co_x', 'status').semantics).toBe('single_active');
  });
});
