/**
 * Ground rule 1, enforced: a shipped migration never changes. The migrator
 * records applied ids per tenant and skips a file it has seen, so an edit
 * would never reach a database that already ran it. Every migration's
 * checksum is pinned in test/golden/migration-checksums.json; a changed
 * file fails here, and a new one fails until its line is added.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrationChecksum } from '../src/db/migration-checksum';

const DIR = join(__dirname, '../src/db/migrations');
const GOLDEN = join(__dirname, 'golden/migration-checksums.json');

const pinned = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
const files = readdirSync(DIR)
  .filter((f) => /^\d{4}_.+\.surql$/.test(f))
  .sort();

describe('migration checksums', () => {
  it('every shipped migration is byte-for-byte what was pinned', () => {
    const changed = files.filter(
      (f) =>
        pinned[f] !== undefined &&
        pinned[f] !== migrationChecksum(readFileSync(join(DIR, f), 'utf8')),
    );
    // Ship the change as a new migration (next free number) instead.
    expect(changed).toEqual([]);
  });

  it('every migration is pinned (add the printed line for a new one)', () => {
    const missing = files
      .filter((f) => pinned[f] === undefined)
      .map((f) => `"${f}": "${migrationChecksum(readFileSync(join(DIR, f), 'utf8'))}"`);
    expect(missing).toEqual([]);
  });

  it('no pinned migration was deleted or renamed', () => {
    expect(Object.keys(pinned).filter((f) => !files.includes(f))).toEqual([]);
  });

  it('a checkout with CRLF line endings is not drift', () => {
    expect(migrationChecksum('DEFINE TABLE a;\r\nDEFINE TABLE b;\r\n')).toBe(
      migrationChecksum('DEFINE TABLE a;\nDEFINE TABLE b;\n'),
    );
  });
});
