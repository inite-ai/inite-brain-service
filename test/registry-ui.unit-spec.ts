/**
 * Registry UI — pure server-rendered catalogue page.
 */
import { renderRegistryPage } from '../src/registry/registry-ui';
import type { RegistryPackSummary } from '../src/contracts/registry/registry.schema';

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
});
