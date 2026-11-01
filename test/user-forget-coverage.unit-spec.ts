/**
 * GATE: every table that stores a `userId` is erased by user forget, or
 * says here why it is not (AGENTS.md ground rule 4: a new table holding
 * user content must be wired into the cascade). memory_file, the user's
 * verbatim notes, sat outside the cascade for months because nothing
 * asked; a new table now fails this spec until someone decides.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '../src/db/migrations');
const CASCADE = [
  join(__dirname, '../src/entities/user-forget.service.ts'),
  join(__dirname, '../src/documents/document-purge.util.ts'),
];

/** Tables with a userId that user forget deliberately leaves, and why. */
const EXEMPT: Record<string, string> = {
  api_key:
    'A credential record in the system database (0144: the tenant copy is unused). It holds no memory content; revoking a departed user’s keys is the key admin’s act.',
};

function userTables(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.surql'))) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    for (const m of sql.matchAll(
      /DEFINE FIELD (?:IF NOT EXISTS |OVERWRITE )?userId ON (?:TABLE )?(\w+)/g,
    )) {
      out.add(m[1]!);
    }
  }
  return [...out].sort();
}

describe('GATE: user forget covers every table with a userId', () => {
  const cascade = CASCADE.map((p) => readFileSync(p, 'utf8')).join('\n');

  it.each(userTables())('%s is erased by user forget or exempt with a reason', (table) => {
    const erased = new RegExp(`\\b(?:FROM|DELETE)\\s+${table}\\b`).test(cascade);
    expect(erased || table in EXEMPT).toBe(true);
  });

  it('every exemption names a table that still exists', () => {
    const tables = new Set(userTables());
    for (const t of Object.keys(EXEMPT)) expect(tables.has(t)).toBe(true);
  });
});
