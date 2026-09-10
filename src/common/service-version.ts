import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The deployed product version, read from package.json once at boot.
 *
 * Both deploy shapes run from the directory that holds package.json
 * (Docker WORKDIR /app with `node dist/main.js`; dev `nest start` from
 * the repo root), so cwd is the stable anchor — the compiled __dirname
 * lives under dist/ where the manifest never ships.
 *
 * Shared so that every "which brain am I talking to" surface answers
 * with the same number: /health, /ready and the MCP health probe, which
 * additionally reports its own protocol-server version.
 */
export const SERVICE_VERSION = ((): string => {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
