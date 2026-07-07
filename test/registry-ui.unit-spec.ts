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

  it('shows an empty state when there are no packs', () => {
    const html = renderRegistryPage([]);
    expect(html).toContain('No packs published yet');
  });
});
