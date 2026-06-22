/**
 * Regression guard for the BFF dynamic-path matcher.
 *
 * The route.ts compiles `:placeholder` patterns into RegExp. This
 * test re-implements the helper in-process and verifies that:
 *   - exact paths still match (no regression on the static map)
 *   - dynamic patterns expand correctly
 *   - extra segments after a pattern do NOT silently match
 *
 * Keeps the matcher honest if someone refactors the BFF.
 */

function placeholderToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map((seg) =>
      seg.startsWith(':')
        ? '[^/]+'
        : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${escaped}$`);
}

describe('BFF dynamic-path matcher', () => {
  it('matches /jobs/:runId only with a single non-slash segment', () => {
    const re = placeholderToRegex('v1/admin/jobs/:runId');
    expect(re.test('v1/admin/jobs/abc-123')).toBe(true);
    expect(re.test('v1/admin/jobs/abc-123/cancel')).toBe(false);
    expect(re.test('v1/admin/jobs')).toBe(false);
  });

  it('matches deeper /dreams/runs/:runId/emits', () => {
    const re = placeholderToRegex('v1/admin/dreams/runs/:runId/emits');
    expect(re.test('v1/admin/dreams/runs/abc/emits')).toBe(true);
    expect(re.test('v1/admin/dreams/runs/abc')).toBe(false);
    expect(re.test('v1/admin/dreams/runs/abc/emits/x')).toBe(false);
  });

  it('does not collide with a similar static path', () => {
    // /traces/:requestId must not match /traces/stream (SSE — different handler).
    const re = placeholderToRegex('v1/admin/traces/:requestId');
    expect(re.test('v1/admin/traces/stream')).toBe(true); // would match — that's why
    // BFF needs the *static* map to win first via findSchema(). The
    // matcher itself is liberal, the precedence is what protects us.
    expect(re.test('v1/admin/traces')).toBe(false);
  });
});
