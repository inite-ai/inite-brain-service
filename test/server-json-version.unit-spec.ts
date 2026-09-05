import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `server.json` is the file the MCP registry publishes and every downstream
 * catalogue reads — pulsemcp, glama, smithery, mcp.so, mcphq all render its
 * `version`.
 *
 * It said `0.1.0` while the package was at `2.1.0`, because release-please
 * carried `docs/openapi.json` in `extra-files` and never carried this one. So
 * the public listings advertised a pre-release of a service two majors past it,
 * and nothing failed when they drifted — the same shape as the OpenAPI drift
 * that `openapi-doc.unit-spec.ts` exists to catch.
 *
 * Proof it bites: set `version` in `server.json` back to `0.1.0`.
 */

const root = join(__dirname, '..');
const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf-8'));

describe('server.json', () => {
  it('publishes the package version', () => {
    expect(read('server.json').version).toBe(read('package.json').version);
  });

  it('is carried by release-please, so it cannot drift again', () => {
    const extra = read('release-please-config.json').packages['.']['extra-files'] as Array<{
      path: string;
      jsonpath: string;
    }>;
    expect(extra.map((e) => e.path)).toContain('server.json');
    expect(extra.find((e) => e.path === 'server.json')?.jsonpath).toBe('$.version');
  });
});
