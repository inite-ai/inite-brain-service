/**
 * Registry UI — pure server-rendered catalogue + publisher pages.
 */
import { renderPublisherPage, renderRegistryPage } from '../src/registry/registry-ui';
import type { RegistryPackSummary } from '../src/contracts/registry/registry.schema';
import type { PublisherProfile } from '../src/contracts/registry/marketplace.schema';

function pack(over: Partial<RegistryPackSummary> = {}): RegistryPackSummary {
  return {
    packId: 'fintech',
    latestVersion: '0.1.0',
    description: 'financial services',
    keywords: ['finance'],
    publisher: 'acme',
    signed: true,
    verified: false,
    downloads: 42,
    publishedAt: '2026-07-01T12:00:00.000Z',
    versionCount: 2,
    ...over,
  };
}

describe('renderRegistryPage', () => {
  it('renders a pack card with id, version, install hint', () => {
    const html = renderRegistryPage([pack()]);
    expect(html).toContain('fintech');
    expect(html).toContain('v0.1.0');
    expect(html).toContain('pnpm pack:install -- --registry fintech');
    expect(html).toContain('signed');
    expect(html).toMatch(/^<!doctype html>/);
  });

  it('HTML-escapes dynamic fields (no injection)', () => {
    const html = renderRegistryPage([
      pack({ description: '<script>alert(1)</script>', keywords: ['<b>x'] }),
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;x');
  });

  it('shows the download count and published date', () => {
    const html = renderRegistryPage([pack()]);
    expect(html).toContain('42 download(s)');
    expect(html).toContain('published 2026-07-01');
  });

  it('renders a green verified badge distinct from the neutral signed marker', () => {
    // verified implies signed → only the stronger badge shows.
    const verified = renderRegistryPage([pack({ verified: true })]);
    expect(verified).toContain('badge verified');
    expect(verified).not.toContain('badge signed');
    // signed-but-unverified → neutral marker only.
    const signedOnly = renderRegistryPage([pack({ signed: true })]);
    expect(signedOnly).toContain('badge signed');
    expect(signedOnly).not.toContain('badge verified');
    // unsigned → no badge at all.
    const unsigned = renderRegistryPage([pack({ signed: false })]);
    expect(unsigned).not.toContain('class="badge');
  });

  it('HTML-escapes the new dynamic fields too (publishedAt injection)', () => {
    const html = renderRegistryPage([pack({ publishedAt: '"><script>x' })]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('shows a "mirrored from <host>" note for mirrored packs only', () => {
    const mirrored = renderRegistryPage([pack({ origin: 'https://upstream.example.com:8443/' })]);
    expect(mirrored).toContain('mirrored from upstream.example.com:8443');
    // Locally published packs carry no note.
    const localOnly = renderRegistryPage([pack()]);
    expect(localOnly).not.toContain('mirrored from');
  });

  it('HTML-escapes an unparseable origin instead of injecting it', () => {
    const html = renderRegistryPage([pack({ origin: '<img src=x onerror=alert(1)>' })]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('shows an empty state when there are no packs', () => {
    const html = renderRegistryPage([]);
    expect(html).toContain('No packs published yet');
  });

  it('does not throw on a non-string field slipping through (coerces, no 500)', () => {
    // A numeric description / null publisher from a hand-written DB row must
    // render, not crash the public page with ".replace is not a function".
    const rogue = pack({
      description: 42 as unknown as string,
      publisher: null,
      latestVersion: 1.0 as unknown as string,
    });
    expect(() => renderRegistryPage([rogue])).not.toThrow();
    expect(renderRegistryPage([rogue])).toContain('42');
  });

  it('renders a Featured section on top, most recently featured first', () => {
    const html = renderRegistryPage([
      pack({ packId: 'plain' }),
      pack({
        packId: 'star_old',
        featured: true,
        featuredAt: '2026-07-01T00:00:00.000Z',
      }),
      pack({
        packId: 'star_new',
        featured: true,
        featuredAt: '2026-07-10T00:00:00.000Z',
      }),
    ]);
    expect(html).toContain('Featured');
    expect(html).toContain('badge featured');
    const idxSection = html.indexOf('class="featured-sec"');
    const idxNew = html.indexOf('star_new');
    const idxOld = html.indexOf('star_old');
    const idxPlain = html.indexOf('plain');
    expect(idxSection).toBeGreaterThan(-1);
    // Featured cards live above the rest, newest featured first.
    expect(idxNew).toBeGreaterThan(idxSection);
    expect(idxOld).toBeGreaterThan(idxNew);
    expect(idxPlain).toBeGreaterThan(idxOld);
    // A featured pack renders exactly once (section, not duplication).
    expect(html.split('star_new').length - 1).toBe(html.split('plain').length - 1);
  });

  it('renders no Featured section when nothing is featured', () => {
    // The stylesheet always carries the .featured-sec rule — assert on the
    // section element itself.
    expect(renderRegistryPage([pack()])).not.toContain('class="featured-sec"');
  });

  it('shows a price badge for paid packs (formatted, or a plain "paid" marker)', () => {
    const priced = renderRegistryPage([
      pack({ paid: true, displayPrice: { amount: 2900, currency: 'usd' } }),
    ]);
    expect(priced).toContain('badge price');
    expect(priced).toContain('29.00 USD');
    const unpriced = renderRegistryPage([pack({ paid: true })]);
    expect(unpriced).toContain('badge price');
    expect(unpriced).toContain('paid');
    // Free packs carry no price badge.
    expect(renderRegistryPage([pack()])).not.toContain('badge price');
  });

  it('links the publisher name to its URI-encoded publisher page', () => {
    const html = renderRegistryPage([pack({ publisher: 'acme co/1' })]);
    expect(html).toContain('href="/registry/ui/publisher/acme%20co%2F1"');
    expect(html).toContain('by <a');
  });
});

describe('renderPublisherPage', () => {
  function profile(over: Partial<PublisherProfile> = {}): PublisherProfile {
    return {
      publisher: 'acme',
      displayName: 'ACME Corp',
      url: 'https://acme.example',
      bio: 'We make packs.',
      contactEmail: 'packs@acme.example',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: null,
      ...over,
    };
  }

  it('renders the profile with a clickable http(s) url and the packs', () => {
    const html = renderPublisherPage({
      publisher: 'acme',
      profile: profile(),
      packs: [pack()],
    });
    expect(html).toContain('ACME Corp');
    expect(html).toContain('We make packs.');
    expect(html).toContain('<a href="https://acme.example"');
    expect(html).toContain('packs@acme.example');
    expect(html).toContain('fintech');
  });

  it('renders a javascript: url as inert text, never a link', () => {
    const hostile = 'javascript' + ':alert(1)';
    const html = renderPublisherPage({
      publisher: 'acme',
      profile: profile({ url: hostile }),
      packs: [],
    });
    expect(html).not.toContain(`href="${hostile}"`);
    expect(html).toContain(hostile); // still visible, escaped + unlinked
  });

  it('HTML-escapes hostile profile fields (no injection)', () => {
    const html = renderPublisherPage({
      publisher: '"><script>p</script>',
      profile: profile({
        displayName: '<script>alert(1)</script>',
        bio: '<img src=x onerror=alert(2)>',
        url: 'not a url "><script>u</script>',
      }),
      packs: [],
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>p');
    expect(html).not.toContain('<script>u');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty-state page for an unknown publisher (no 500)', () => {
    const html = renderPublisherPage({
      publisher: 'ghost',
      profile: null,
      packs: [],
    });
    expect(html).toContain('ghost');
    expect(html).toContain('No packs from this publisher');
    expect(html).toMatch(/^<!doctype html>/);
  });
});
