/**
 * Marketplace metadata shaping — the pure merge / featured-split / price
 * formatting rules (src/registry/marketplace-meta.ts).
 */
import {
  formatPrice,
  isHttpUrl,
  mergeMarketplaceMeta,
  splitFeatured,
  type PackMarketplaceMeta,
} from '../src/registry/marketplace-meta';
import type { RegistryPackSummary } from '../src/contracts/registry/registry.schema';

function summary(over: Partial<RegistryPackSummary> = {}): RegistryPackSummary {
  return {
    packId: 'fintech',
    latestVersion: '0.1.0',
    description: 'financial services',
    keywords: [],
    publisher: 'acme',
    signed: false,
    verified: false,
    downloads: 0,
    versionCount: 1,
    ...over,
  };
}

function meta(over: Partial<PackMarketplaceMeta> = {}): PackMarketplaceMeta {
  return {
    packId: 'fintech',
    featured: false,
    featuredAt: null,
    paid: false,
    priceCode: null,
    displayPrice: null,
    ...over,
  };
}

describe('mergeMarketplaceMeta', () => {
  it('stamps featured + paid + displayPrice from the meta map', () => {
    const [merged] = mergeMarketplaceMeta(
      [summary()],
      new Map([
        [
          'fintech',
          meta({
            featured: true,
            featuredAt: '2026-07-15T00:00:00.000Z',
            paid: true,
            priceCode: 'pack_fintech_1',
            displayPrice: { amount: 2900, currency: 'USD' },
          }),
        ],
      ]),
    );
    expect(merged!.featured).toBe(true);
    expect(merged!.featuredAt).toBe('2026-07-15T00:00:00.000Z');
    expect(merged!.paid).toBe(true);
    expect(merged!.displayPrice).toEqual({ amount: 2900, currency: 'USD' });
  });

  it('leaves packs without a meta row byte-identical (no stamped keys)', () => {
    const [merged] = mergeMarketplaceMeta([summary()], new Map());
    expect(merged).toEqual(summary());
    expect('featured' in merged!).toBe(false);
    expect('paid' in merged!).toBe(false);
  });

  it('does not stamp false/empty state (unfeatured free row = clean wire)', () => {
    const [merged] = mergeMarketplaceMeta(
      [summary()],
      new Map([['fintech', meta()]]),
    );
    expect('featured' in merged!).toBe(false);
    expect('paid' in merged!).toBe(false);
    expect('displayPrice' in merged!).toBe(false);
  });

  it('stamps paid without displayPrice when the meta row lacks one', () => {
    const [merged] = mergeMarketplaceMeta(
      [summary()],
      new Map([['fintech', meta({ paid: true })]]),
    );
    expect(merged!.paid).toBe(true);
    expect('displayPrice' in merged!).toBe(false);
  });
});

describe('splitFeatured', () => {
  it('splits featured packs on top, most recently featured first', () => {
    const packs = [
      summary({ packId: 'a' }),
      summary({
        packId: 'older',
        featured: true,
        featuredAt: '2026-07-01T00:00:00.000Z',
      }),
      summary({ packId: 'b' }),
      summary({
        packId: 'newer',
        featured: true,
        featuredAt: '2026-07-10T00:00:00.000Z',
      }),
    ];
    const { featured, rest } = splitFeatured(packs);
    expect(featured.map((p) => p.packId)).toEqual(['newer', 'older']);
    expect(rest.map((p) => p.packId)).toEqual(['a', 'b']);
  });

  it('handles no featured packs (everything in rest, order preserved)', () => {
    const packs = [summary({ packId: 'a' }), summary({ packId: 'b' })];
    const { featured, rest } = splitFeatured(packs);
    expect(featured).toEqual([]);
    expect(rest.map((p) => p.packId)).toEqual(['a', 'b']);
  });

  it('sinks a featured pack without featuredAt below dated ones', () => {
    const packs = [
      summary({ packId: 'undated', featured: true }),
      summary({
        packId: 'dated',
        featured: true,
        featuredAt: '2026-07-10T00:00:00.000Z',
      }),
    ];
    const { featured } = splitFeatured(packs);
    expect(featured.map((p) => p.packId)).toEqual(['dated', 'undated']);
  });
});

describe('formatPrice', () => {
  it('renders minor units as a 2-decimal amount + uppercased currency', () => {
    expect(formatPrice({ amount: 2900, currency: 'usd' })).toBe('29.00 USD');
    expect(formatPrice({ amount: 999, currency: 'EUR' })).toBe('9.99 EUR');
    expect(formatPrice({ amount: 5, currency: 'GBP' })).toBe('0.05 GBP');
  });
});

describe('isHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://acme.example')).toBe(true);
    expect(isHttpUrl('http://acme.example/path?q=1')).toBe(true);
  });

  it('rejects javascript:, other schemes and garbage', () => {
    expect(isHttpUrl('javascript' + ':alert(1)')).toBe(false);
    expect(isHttpUrl('ftp://acme.example')).toBe(false);
    expect(isHttpUrl('data:text/html,x')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});
