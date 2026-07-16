import type { RegistryPackSummary } from '../contracts/registry/registry.schema';
import type { DisplayPrice } from '../contracts/registry/marketplace.schema';

/**
 * Pure marketplace-metadata shaping (docs/domain-packs.md "Marketplace"):
 * stamp instance-local registry_pack_meta rows (migration 0066) onto
 * catalogue summaries, split out the featured section, and format display
 * prices. Dependency-free so the merge/curation rules are unit-testable
 * without a DB — the services supply the rows.
 */

/** One registry_pack_meta row, normalized (RegistryMetaService reads). */
export interface PackMarketplaceMeta {
  packId: string;
  featured: boolean;
  featuredAt: string | null;
  paid: boolean;
  priceCode: string | null;
  displayPrice: DisplayPrice | null;
}

/**
 * Stamp marketplace metadata onto catalogue summaries. Only meaningful
 * state is stamped (featured/paid present-and-true or absent), so packs
 * without a meta row — the common case — serialize byte-identically to
 * the pre-marketplace wire shape.
 */
export function mergeMarketplaceMeta(
  summaries: RegistryPackSummary[],
  metaMap: Map<string, PackMarketplaceMeta>,
): RegistryPackSummary[] {
  return summaries.map((s) => {
    const meta = metaMap.get(s.packId);
    if (!meta || (!meta.featured && !meta.paid)) return s;
    return {
      ...s,
      ...(meta.featured
        ? {
            featured: true,
            ...(meta.featuredAt ? { featuredAt: meta.featuredAt } : {}),
          }
        : {}),
      ...(meta.paid
        ? {
            paid: true,
            ...(meta.displayPrice ? { displayPrice: meta.displayPrice } : {}),
          }
        : {}),
    };
  });
}

/** Split a merged catalogue into the featured section (most recently
 *  featured first) and the rest, both order-stable otherwise. */
export function splitFeatured(packs: RegistryPackSummary[]): {
  featured: RegistryPackSummary[];
  rest: RegistryPackSummary[];
} {
  const featured = packs.filter((p) => p.featured === true);
  // ISO 8601 strings sort lexicographically; missing featuredAt sinks last.
  featured.sort((a, b) =>
    (b.featuredAt ?? '').localeCompare(a.featuredAt ?? ''),
  );
  return { featured, rest: packs.filter((p) => p.featured !== true) };
}

/** Minor units → a human display string ("29.00 USD"). */
export function formatPrice(price: DisplayPrice): string {
  return `${(price.amount / 100).toFixed(2)} ${price.currency.toUpperCase()}`;
}

/** Strict http(s) parse — the profile validator and the UI's
 *  anti-`javascript:` link rule share one definition of "a safe URL". */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
