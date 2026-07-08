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
