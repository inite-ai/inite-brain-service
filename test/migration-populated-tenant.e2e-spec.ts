/**
 * A migration lands on a tenant that already holds rows, on a REAL
 * SurrealDB (testcontainers, v3.2.4).
 *
 * Every other migration spec applies the manifest to an empty database.
 * That is how 0184 (#901) passed CI and then failed on every production
 * tenant holding a fact or a turn (2026-11-13): it defines the `stems`
 * analyzer and a FULLTEXT index using it in one file, and 3.2.4 builds the
 * index over existing rows inside `DEFINE INDEX`, looking the analyzer up
 * in the committed catalogue, where an analyzer defined earlier in the same
 * transaction is not yet visible ("The analyzer 'stems' does not exist").
 * On an empty table there is nothing to build, so nothing failed. A failing
 * file holds the whole tenant: every request and every job claim migrates
 * first. The migrator now commits a file's analyzers ahead of it
 * (SchemaMigrator.defineAnalyzersFirst).
 */
import { Surreal } from 'surrealdb';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaMigrator } from '../src/db/migrator.service';

const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations');
/** Own namespace: the shared container also hosts every other e2e spec. */
const NS = `mig_rows_${Date.now()}`;

async function connect(database: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(process.env.SURREALDB_URL!);
  await db.signin({
    username: process.env.SURREALDB_USERNAME ?? 'root',
    password: process.env.SURREALDB_PASSWORD ?? 'root',
  });
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS \`${NS}\``);
  await db.use({ namespace: NS });
  await db.query(`DEFINE DATABASE IF NOT EXISTS \`${database}\``);
  await db.use({ namespace: NS, database });
  return db;
}

async function appliedIds(conn: Surreal): Promise<string[]> {
  const [rows] = await conn.query<[Array<{ migrationId: string }>]>(
    `SELECT migrationId FROM schema_migrations`,
  );
  return (rows ?? []).map((r) => r.migrationId).sort();
}

async function info(conn: Surreal, what: string): Promise<Record<string, Record<string, string>>> {
  const [res] = await conn.query<[Record<string, Record<string, string>>]>(`INFO FOR ${what}`);
  return res;
}

describe('a migration on a tenant that already holds rows (real SurrealDB)', () => {
  let dir: string;
  const conns: Surreal[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mig-rows-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterAll(async () => {
    for (const c of conns) await c.close().catch(() => undefined);
    const root = await connect('cleanup');
    await root.query(`REMOVE NAMESPACE IF EXISTS \`${NS}\``).catch(() => undefined);
    await root.close();
  });

  it('defines an analyzer and a FULLTEXT index on it in one file over existing rows', async () => {
    const conn = await connect('co_analyzer_and_index');
    conns.push(conn);
    await writeFile(join(dir, '0001_table.surql'), 'DEFINE TABLE IF NOT EXISTS note SCHEMALESS;');
    await new SchemaMigrator(dir).migrate(conn);
    await conn.query(`CREATE note SET body = 'contracts signed'`);

    await writeFile(
      join(dir, '0002_search.surql'),
      [
        '-- an analyzer; the index below uses it',
        'DEFINE ANALYZER IF NOT EXISTS words',
        '  TOKENIZERS blank',
        '  FILTERS lowercase;',
        'DEFINE INDEX IF NOT EXISTS note_body_idx ON note FIELDS body FULLTEXT ANALYZER words BM25;',
      ].join('\n'),
    );
    const result = await new SchemaMigrator(dir).migrate(conn);

    expect(result.applied).toEqual(['0002']);
    expect(await appliedIds(conn)).toEqual(['0001', '0002']);
    expect(Object.keys((await info(conn, 'TABLE note')).indexes ?? {})).toContain('note_body_idx');
    const [hits] = await conn.query<[unknown[]]>(`SELECT id FROM note WHERE body @@ 'contracts'`);
    expect(hits).toHaveLength(1);
  });

  it('applies 0184 and everything after it to a tenant with a turn and a fact', async () => {
    const conn = await connect('co_populated');
    conns.push(conn);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.surql$/.test(f));
    for (const f of files.filter((f) => f < '0184')) {
      await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    }
    await new SchemaMigrator(dir).migrate(conn);

    // The state of a production tenant before 2.8.0: it holds a turn and a fact.
    await conn.query(
      `CREATE episode CONTENT {
         kind: 'turn', messageId: 'm1', text: 'Мария Петрова подписала контракты',
         lang: 'ru', occurredAt: time::now(), source: { type: 'chat' }
       } RETURN NONE;
       LET $e = (CREATE ONLY knowledge_entity CONTENT { canonicalName: 'мария петрова', type: 'customer' });
       CREATE knowledge_fact CONTENT {
         entityId: $e.id, predicate: 'signed', object: 'контракты', confidence: 0.9,
         validFrom: time::now(), source: { type: 'chat' }, lang: 'ru'
       } RETURN NONE;`,
    );
    const [[episodes], [facts]] = [
      await conn.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM episode GROUP ALL`),
      await conn.query<[Array<{ n: number }>]>(`SELECT count() AS n FROM knowledge_fact GROUP ALL`),
    ];
    expect(episodes[0]?.n).toBe(1);
    expect(facts[0]?.n).toBe(1);

    for (const f of files.filter((f) => f >= '0184')) {
      await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    }
    const result = await new SchemaMigrator(dir).migrate(conn);

    expect(result.applied[0]).toBe('0184');
    expect(await appliedIds(conn)).toEqual(files.map((f) => f.slice(0, 4)).sort());
    expect(Object.keys((await info(conn, 'DB')).analyzers ?? {})).toContain('stems');
    expect(Object.keys((await info(conn, 'TABLE episode')).indexes ?? {})).toContain(
      'episode_text_stem_idx',
    );
    expect(Object.keys((await info(conn, 'TABLE knowledge_fact')).indexes ?? {})).toContain(
      'fact_haystack_stem_idx',
    );
  });
});
