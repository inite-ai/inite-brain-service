import type {
  DeclaredSource,
  PublicDeclaredSource,
  PublicSourceDetailResponse,
  PublicSourceSummary,
  SourceDetailResponse,
  SourceSummary,
  SourceType,
} from '../contracts/sources/sources.schema';

/**
 * Pure projection from the admin source shapes to the public /v1/sources
 * wire (trust-inputs track). The public surface exposes what a consumer
 * needs to weigh a fact's trustSnapshot — declared type/authLevel and the
 * learned rates — and drops the operator annotations (owner/note) plus
 * the registry row timestamps, which stay brain:admin-only.
 */

/** Detail history cap — the admin surface serves up to 100 rows. */
export const PUBLIC_HISTORY_LIMIT = 50;
export const PUBLIC_LIST_MAX_LIMIT = 200;

export function toPublicDeclared(declared: DeclaredSource | null): PublicDeclaredSource | null {
  if (!declared) return null;
  return { type: declared.type, authLevel: declared.authLevel };
}

/** domainRequested mirrors the ?domain= query: the domainTrust slot is
 *  present (possibly null) iff the caller asked for a domain. */
export function toPublicSummary(
  summary: SourceSummary,
  domainRequested: boolean,
): PublicSourceSummary {
  return {
    sourceKey: summary.sourceKey,
    declared: toPublicDeclared(summary.declared),
    globalTrust: summary.globalTrust,
    scopedDomains: summary.scopedDomains,
    ...(domainRequested ? { domainTrust: summary.domainTrust ?? null } : {}),
  };
}

/** History arrives newest-first from the service — the slice keeps the
 *  50 most recent rows. */
export function toPublicDetail(detail: SourceDetailResponse): PublicSourceDetailResponse {
  return {
    sourceKey: detail.sourceKey,
    declared: toPublicDeclared(detail.declared),
    trust: detail.trust,
    history: detail.history.slice(0, PUBLIC_HISTORY_LIMIT),
  };
}

export interface PublicListFilter {
  type?: SourceType;
  minSamples?: number;
  domain?: string;
  limit: number;
  offset: number;
}

/**
 * Filter → sort (by sourceKey) → page → project. `total` counts the
 * filtered set before paging so callers can walk pages. With an active
 * domain filter, minSamples judges the domain-scoped row when the source
 * has one and falls back to the global row otherwise.
 */
export function filterAndPage(
  summaries: SourceSummary[],
  filter: PublicListFilter,
): { items: PublicSourceSummary[]; total: number } {
  const domainRequested = filter.domain !== undefined;
  const filtered = summaries.filter((s) => {
    if (filter.type !== undefined && s.declared?.type !== filter.type) {
      return false;
    }
    if (filter.minSamples !== undefined) {
      const basis = domainRequested ? (s.domainTrust ?? s.globalTrust) : s.globalTrust;
      if ((basis?.sampleCount ?? 0) < filter.minSamples) return false;
    }
    return true;
  });
  filtered.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  const limit = Math.min(filter.limit, PUBLIC_LIST_MAX_LIMIT);
  const items = filtered
    .slice(filter.offset, filter.offset + limit)
    .map((s) => toPublicSummary(s, domainRequested));
  return { items, total: filtered.length };
}
