/**
 * Verifies a two-node SurrealDB deployment (deploy/surreal-ha) does
 * everything Brain needs from its database, end to end:
 *
 *   1. migrations   — Brain's SurrealService migrates a fresh tenant
 *                     through the balanced address (every shipped file).
 *   2. shared state — a row written on node A is read on node B.
 *   3. full text    — a BM25 index fed on A answers on B.
 *   4. vectors      — an HNSW index fed on A answers a KNN on B.
 *   5. changefeed   — SHOW CHANGES on B lists a write made on A.
 *   6. live query   — a LIVE SELECT on B hears a write on A. SurrealDB
 *                     3.2 delivers LIVE notifications only on the node
 *                     that ran the write, so this is expected to fail;
 *   7. live, Brain  — what Brain's subscribers see across nodes: the
 *                     LiveSubscriptionManager on B still delivers a fact
 *                     written on A, through its changefeed catch-up.
 *   8. contention   — the same row updated from both nodes at once:
 *                     every writer lands through Brain's OCC retry.
 *   9. failover     — Brain's pool keeps answering through the balanced
 *                     address while node A is stopped, and after it
 *                     returns.
 *
 * Run (stack up, see deploy/surreal-ha/docker-compose.yml):
 *   pnpm ha:verify
 * Env: HA_URL (balanced, default ws://127.0.0.1:8030), HA_NODE_A /
 * HA_NODE_B (direct, 8031 / 8032), HA_PROJECT (compose project,
 * surreal-ha — used to stop and start node A).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Surreal, Table } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { retryOnReadConflict } from '../src/db/surreal-retry';
import { runTransaction } from '../src/db/run-transaction';
import { LiveSubscriptionManager } from '../src/live/live-subscription.manager';

const HA_URL = process.env.HA_URL ?? 'ws://127.0.0.1:8030';
const NODE_A = process.env.HA_NODE_A ?? 'ws://127.0.0.1:8031';
const NODE_B = process.env.HA_NODE_B ?? 'ws://127.0.0.1:8032';
const PROJECT = process.env.HA_PROJECT ?? 'surreal-ha';
const NS = 'brain';

type Check = { name: string; ok: boolean; detail: string; known?: boolean };
const results: Check[] = [];

/** `known`: a limitation of SurrealDB itself, reported but not failing the run. */
async function check(name: string, fn: () => Promise<string>, known = false): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: `${detail} (${Date.now() - started} ms)` });
  } catch (e) {
    results.push({ name, ok: false, known, detail: (e as Error).message });
  }
  const last = results[results.length - 1]!;
  const mark = last.ok ? '✓' : known ? '•' : '✗';
  console.log(
    `${mark} ${name}: ${last.detail}${!last.ok && known ? ' (known SurrealDB limitation)' : ''}`,
  );
}

async function node(url: string, db: string): Promise<Surreal> {
  const conn = new Surreal();
  await conn.connect(url);
  await conn.signin({ username: 'root', password: 'root' });
  await conn.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS}`);
  await conn.use({ namespace: NS });
  await conn.query(`DEFINE DATABASE IF NOT EXISTS ${db}`);
  await conn.use({ namespace: NS, database: db });
  return conn;
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function compose(...args: string[]): void {
  execFileSync(
    'docker',
    ['compose', '-f', 'deploy/surreal-ha/docker-compose.yml', '-p', PROJECT, ...args],
    { stdio: 'ignore' },
  );
}

async function main(): Promise<void> {
  const companyId = `ha_${randomUUID().slice(0, 8)}`;
  const scratch = `ha_scratch_${randomUUID().slice(0, 8)}`;
  const config = new ConfigService({
    SURREALDB_URL: HA_URL,
    SURREALDB_USERNAME: 'root',
    SURREALDB_PASSWORD: 'root',
    SURREALDB_NAMESPACE: NS,
    SURREALDB_POOL_SIZE: '4',
    SURREALDB_SCOPED_POOL_SIZE: '2',
  });
  const brain = new SurrealService(config);
  await brain.onModuleInit();
  const a = await node(NODE_A, scratch);
  const b = await node(NODE_B, scratch);

  try {
    await check('migrations through the balanced address', async () => {
      const tables = await brain.withCompany(companyId, async (db) => {
        const [info] = await db.query<[{ tables: Record<string, unknown> }]>('INFO FOR DB');
        const [applied] = await db.query<[Array<{ n: number }>]>(
          'SELECT count() AS n FROM schema_migrations GROUP ALL',
        );
        return { tables: Object.keys(info.tables).length, applied: applied?.[0]?.n ?? 0 };
      });
      if (tables.applied === 0) throw new Error('no migration recorded');
      return `${tables.applied} migrations applied, ${tables.tables} tables`;
    });

    await check('a write on A is read on B', async () => {
      await a.query(`CREATE probe:one CONTENT { v: 'from-a' }`);
      const [rows] = await b.query<[Array<{ v: string }>]>(`SELECT v FROM probe:one`);
      if (rows?.[0]?.v !== 'from-a') throw new Error(`B read ${JSON.stringify(rows)}`);
      return 'read back';
    });

    await check('BM25 index fed on A answers on B', async () => {
      await a.query(`DEFINE ANALYZER IF NOT EXISTS simple TOKENIZERS blank FILTERS lowercase;
        DEFINE INDEX IF NOT EXISTS doc_text ON doc FIELDS text FULLTEXT ANALYZER simple BM25;
        CREATE doc:1 CONTENT { text: 'payments move to adyen' };
        CREATE doc:2 CONTENT { text: 'the garden needs water' };`);
      const hit = await until('bm25 hit on B', 5000, async () => {
        const [rows] = await b.query<[Array<{ id: unknown }>]>(
          `SELECT id FROM doc WHERE text @1@ 'adyen'`,
        );
        return rows?.length ? String(rows[0]!.id) : undefined;
      });
      if (hit !== 'doc:1') throw new Error(`wrong hit ${hit}`);
      return 'hit doc:1';
    });

    await check('HNSW index fed on A answers a KNN on B', async () => {
      await a.query(`DEFINE INDEX IF NOT EXISTS vec_idx ON vec FIELDS e HNSW DIMENSION 3 DIST COSINE;
        CREATE vec:x CONTENT { e: [1.0, 0.0, 0.0] };
        CREATE vec:y CONTENT { e: [0.0, 1.0, 0.0] };`);
      const hit = await until('knn hit on B', 5000, async () => {
        const [rows] = await b.query<[Array<{ id: unknown }>]>(
          `SELECT id FROM vec WHERE e <|1,40|> [0.9, 0.1, 0.0]`,
        );
        return rows?.length ? String(rows[0]!.id) : undefined;
      });
      if (hit !== 'vec:x') throw new Error(`wrong neighbour ${hit}`);
      // A vector written on B after the index exists is found from A too.
      await b.query(`CREATE vec:z CONTENT { e: [0.0, 0.0, 1.0] }`);
      const back = await until('knn hit on A', 5000, async () => {
        const [rows] = await a.query<[Array<{ id: unknown }>]>(
          `SELECT id FROM vec WHERE e <|1,40|> [0.0, 0.1, 0.9]`,
        );
        return rows?.length && String(rows[0]!.id) === 'vec:z' ? 'vec:z' : undefined;
      });
      return `B found ${hit}, A found ${back}`;
    });

    await check('SHOW CHANGES on B lists a write made on A', async () => {
      await a.query(
        `DEFINE TABLE IF NOT EXISTS feed CHANGEFEED 1h; CREATE feed:1 CONTENT { v: 1 };`,
      );
      const n = await until('changefeed on B', 5000, async () => {
        const [rows] = await b.query<[unknown[]]>(`SHOW CHANGES FOR TABLE feed SINCE 0 LIMIT 10`);
        return rows && rows.length > 0 ? rows.length : undefined;
      });
      return `${n} change set(s)`;
    });

    await check(
      'LIVE SELECT on B hears a write on A',
      async () => {
        const heard: unknown[] = [];
        await a.query(`DEFINE TABLE IF NOT EXISTS live_probe SCHEMALESS`);
        const live = await b.live<Record<string, unknown>>(new Table('live_probe'));
        live.subscribe((msg) => heard.push(msg));
        await a.query(`CREATE live_probe:1 CONTENT { v: 'hello' }`);
        await until('live notification', 5000, async () => (heard.length ? true : undefined));
        await live.kill();
        return `${heard.length} notification(s)`;
      },
      true,
    );

    await check("Brain's live subscription on B delivers a fact written on A", async () => {
      const pinned = (url: string) =>
        new ConfigService({
          SURREALDB_URL: url,
          SURREALDB_USERNAME: 'root',
          SURREALDB_PASSWORD: 'root',
          SURREALDB_NAMESPACE: NS,
          SURREALDB_POOL_SIZE: '2',
          SURREALDB_SCOPED_POOL_SIZE: '1',
        });
      const writer = new SurrealService(pinned(NODE_A));
      await writer.onModuleInit();
      const mgr = new LiveSubscriptionManager(pinned(NODE_B));
      const got: Array<{ object: string; via: string; at: number }> = [];
      const handle = await mgr.subscribe(companyId, {
        callerScopes: ['brain:read'],
        sink: (e) => {
          if (e.kind === 'fact') got.push({ object: e.object, via: e.via, at: Date.now() });
        },
      });
      try {
        const written = Date.now();
        await writer.withCompany(companyId, async (db) => {
          const [ent] = await db.query<[Array<{ id: unknown }>]>(
            `CREATE knowledge_entity CONTENT { type: 'topic', canonicalName: 'ha probe' }`,
          );
          await db.query(
            `CREATE knowledge_fact SET entityId = $e, predicate = 'ha_probe', object = 'across nodes',
               confidence = 0.9, validFrom = time::now(), source = { vertical: 'ha', eventId: 'ha.probe' }`,
            { e: ent![0]!.id },
          );
        });
        const hit = await until('delivery', 30_000, async () =>
          got.find((g) => g.object === 'across nodes'),
        );
        return `delivered via ${hit.via} after ${hit.at - written} ms`;
      } finally {
        await handle.close();
        await mgr.onApplicationShutdown();
        await writer.onApplicationShutdown();
      }
    });

    await check('one row updated from both nodes at once', async () => {
      await a.query(`CREATE counter:c CONTENT { n: 0 }`);
      const writers = 20;
      const bump = (conn: Surreal) =>
        retryOnReadConflict(() =>
          runTransaction(conn, (tx) => tx.add('UPDATE counter:c SET n += 1').add('RETURN true')),
        );
      await Promise.all(Array.from({ length: writers }, (_, i) => bump(i % 2 === 0 ? a : b)));
      const [rows] = await a.query<[Array<{ n: number }>]>(`SELECT n FROM counter:c`);
      if (rows?.[0]?.n !== writers) throw new Error(`n=${rows?.[0]?.n}, want ${writers}`);
      return `${writers}/${writers} increments landed`;
    });

    await check("Brain's pool rides out node A stopping and returning", async () => {
      let ok = 0;
      let failed = 0;
      let firstFailAt = 0;
      let recoveredAt = 0;
      const ping = async () => {
        try {
          await brain.withCompany(companyId, (db) =>
            db.query('SELECT count() FROM schema_migrations GROUP ALL'),
          );
          ok++;
          if (firstFailAt && !recoveredAt) recoveredAt = Date.now();
        } catch {
          failed++;
          if (!firstFailAt) firstFailAt = Date.now();
        }
      };
      for (let i = 0; i < 10; i++) await ping();
      compose('stop', 'surreal-a');
      const stoppedAt = Date.now();
      for (let i = 0; i < 60; i++) {
        await ping();
        await new Promise((r) => setTimeout(r, 250));
      }
      compose('start', 'surreal-a');
      for (let i = 0; i < 20; i++) {
        await ping();
        await new Promise((r) => setTimeout(r, 250));
      }
      const outage = firstFailAt ? (recoveredAt || Date.now()) - firstFailAt : 0;
      if (ok < 80) throw new Error(`only ${ok}/90 queries answered (${failed} failed)`);
      return `${ok}/90 answered, ${failed} failed, longest gap ${outage} ms after the stop at +${firstFailAt ? firstFailAt - stoppedAt : 0} ms`;
    });
  } finally {
    await a.query(`REMOVE DATABASE IF EXISTS ${scratch}`).catch(() => undefined);
    await a.query(`REMOVE DATABASE IF EXISTS co_${companyId}`).catch(() => undefined);
    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    await brain.onApplicationShutdown();
  }
  const failed = results.filter((r) => !r.ok && !r.known);
  const known = results.filter((r) => !r.ok && r.known).length;
  console.log(
    `\n${results.length - failed.length - known}/${results.length} checks passed` +
      (known ? `, ${known} known SurrealDB limitation(s)` : ''),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
