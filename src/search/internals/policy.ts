import { policyFor } from '../../ingest/conflict-resolver';
import type { SearchDto } from '../dto/search.dto';
import type { FactRow } from './types';

/**
 * Scope-gate predicate filter. Drops rows whose predicate carries a
 * `requiresScope` policy that the caller doesn't hold. Pure helper —
 * applied after fusion (so a query that semantically matches but is
 * filtered by scope returns zero rather than silently demoting).
 *
 * `dto` is accepted to keep the signature stable for future per-DTO
 * gates, even though the current logic only reads predicate policy.
 *
 * NOTE: the pipeline now filters through makeRowPolicyFilter
 * (src/policy/row-filter.ts), which applies this same scope gate FIRST
 * and then the per-key ABAC row verdict. This function stays as the
 * scope-gate reference implementation and for unit tests.
 */
export function passesPolicy(
  row: FactRow,
  _dto: SearchDto,
  callerScopes: string[],
): boolean {
  const policy = policyFor(row.predicate);
  if (policy.requiresScope && !callerScopes.includes(policy.requiresScope)) {
    return false;
  }
  return true;
}
