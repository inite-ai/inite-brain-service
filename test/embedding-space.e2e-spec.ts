/**
 * Multilingual Tier 2 e2e — proves against a REAL SurrealDB that:
 *   - migration 0101 applies on the tenant DB;
 *   - the `embeddingSpaceId` column round-trips on knowledge_fact;
 *   - the per-tenant embedding_space_state + ATOMIC cutover round-trip;
 *   - the reindex sweep stamps `embeddingSpaceId` under EMBEDDING_SPACE_TRACKING.
 *
 * The strict-space guard is a property of the REAL EmbedderService, which the
 * app-fixture replaces with StubEmbedder — so it is proven at the unit level
 * (embedder-space-guard.unit-spec) against the real serveProvider logic, not
 * here. No paid eval: the embedder is stubbed and no synthesize/OpenAI call
 * is made.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EmbeddingSpaceService } from '../src/ai/embedder/embedding-space.service';
import { ReindexEmbeddingsService } from '../src/ai/embedder/reindex-embeddings.service';

const OPENAI_SPACE = 'openai:text-embedding-3-small:1536:l2';
const BGE_SPACE = 'bge-m3:Xenova/bge-m3:1024:l2';

describe('Multilingual Tier 2 — embedding-space e2e (migration 0101)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    for (const k of [
      'EMBEDDING_SPACE_STRICT',
      'EMBEDDING_SPACE_TRACKING',
      'EMBEDDING_SPACE_ACTIVE',
      'EMBEDDING_SPACE_DUAL_WRITE',
    ]) {
      delete process.env[k];
    }
    f = await createApp();
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'space_tenant' },
        predicate: 'status',
        object: 'active',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
      });
  });

  afterAll(async () => {
    for (const k of [
      'EMBEDDING_SPACE_STRICT',
      'EMBEDDING_SPACE_TRACKING',
      'EMBEDDING_SPACE_ACTIVE',
      'EMBEDDING_SPACE_DUAL_WRITE',
    ]) {
      delete process.env[k];
    }
    if (f) await f.close();
  });

  it('migration 0101 is applied on the tenant DB', async () => {
    const surreal = f.app.get(SurrealService);
    const count = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ migrationId: string }>]>(
        `SELECT migrationId FROM schema_migrations WHERE migrationId = '0101'`,
      );
      return ((rows as Array<{ migrationId: string }>) ?? []).length;
    });
    expect(count).toBe(1);
  });

  it('embeddingSpaceId column round-trips on knowledge_fact', async () => {
    const surreal = f.app.get(SurrealService);
    const value = await surreal.withCompany(f.companyId, async (db) => {
      const [facts] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_fact LIMIT 1`,
      );
      const id = (facts as Array<{ id: unknown }>)[0]?.id;
      expect(id).toBeTruthy();
      await db.query(`UPDATE $id SET embeddingSpaceId = $s`, { id, s: OPENAI_SPACE });
      const [rows] = await db.query<[Array<{ embeddingSpaceId?: string }>]>(
        `SELECT embeddingSpaceId FROM knowledge_fact WHERE id = $id`,
        { id },
      );
      return (rows as Array<{ embeddingSpaceId?: string }>)[0]?.embeddingSpaceId;
    });
    expect(value).toBe(OPENAI_SPACE);
  });

  it('embedding_space_state + atomic cutover round-trip on a real DB', async () => {
    process.env.EMBEDDING_SPACE_ACTIVE = '1';
    process.env.EMBEDDING_SPACE_DUAL_WRITE = '1';
    try {
      const spaces = f.app.get(EmbeddingSpaceService);
      await spaces.beginMigration(f.companyId, BGE_SPACE);
      const mid = await spaces.getState(f.companyId);
      expect(mid.targetSpace).toBe(BGE_SPACE);
      expect(mid.dualWrite).toBe(true);

      const after = await spaces.cutover(f.companyId, BGE_SPACE);
      expect(after.activeSpace).toBe(BGE_SPACE);
      expect(after.targetSpace).toBeNull();
      expect(after.dualWrite).toBe(false);
      // The resolver now serves the target space wholly.
      expect(await spaces.activeSpaceFor(f.companyId)).toBe(BGE_SPACE);
    } finally {
      delete process.env.EMBEDDING_SPACE_ACTIVE;
      delete process.env.EMBEDDING_SPACE_DUAL_WRITE;
    }
  });

  it('reindex sweep stamps embeddingSpaceId under EMBEDDING_SPACE_TRACKING', async () => {
    const surreal = f.app.get(SurrealService);
    // Clear any stamp left by an earlier test so we observe the reindex write.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`UPDATE knowledge_fact SET embeddingSpaceId = NONE`);
    });

    process.env.EMBEDDING_SPACE_TRACKING = '1';
    try {
      const reindex = f.app.get(ReindexEmbeddingsService);
      const res = await reindex.run({ tenant: f.companyId });
      expect(res.factsUpdated).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.EMBEDDING_SPACE_TRACKING;
    }

    const stamped = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ embeddingSpaceId?: string }>]>(
        `SELECT embeddingSpaceId FROM knowledge_fact WHERE embeddingSpaceId != NONE`,
      );
      return (rows as Array<{ embeddingSpaceId?: string }>) ?? [];
    });
    expect(stamped.length).toBeGreaterThanOrEqual(1);
    // StubEmbedder emulates the default OpenAI 1536 space.
    expect(stamped[0]!.embeddingSpaceId).toBe(OPENAI_SPACE);
  });
});

/**
 * What a wrong-width vector ACTUALLY does, against a real SurrealDB.
 *
 * This is the empirical basis for the unconditional write guard in
 * EmbedderService: the store does not protect the corpus, so the service
 * has to. Each expectation below was first reproduced by hand against
 * surrealdb/surrealdb:v3.2.4 (the version docker-compose.yml pins).
 *
 * The headline is counter-intuitive: the DANGEROUS operation is the WRITE,
 * which succeeds, and the SAFE-looking operation is the READ, which then
 * fails for the whole table — including for every correctly-written row.
 */
describe('cross-width vectors on a real SurrealDB', () => {
  let f: AppFixture;
  const W_BGE = 1024;
  const W_OPENAI = 1536;
  const vec = (w: number) => new Array(w).fill(0.1);

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('accepts BOTH widths into the same column — the store is no guard', async () => {
    const surreal = f.app.get(SurrealService);
    const widths = await surreal.withCompany(f.companyId, async (db) => {
      // `option<array<float>>` (migration 0001) carries no width, so a
      // fallback-width vector lands silently and permanently.
      await db.query(`DELETE knowledge_fact WHERE predicate = 'width_probe'`);
      const [ents] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity SET type = 'other', canonicalName = 'width probe'`,
      );
      const entityId = (ents as Array<{ id: unknown }>)[0]!.id;
      const row = (object: string, v: number[]) =>
        db.query(
          `CREATE knowledge_fact SET entityId = $e, predicate = 'width_probe',
             object = $o, confidence = 0.9, validFrom = time::now(),
             source = { vertical: 'rent', eventId: 'width.probe' }, embedding = $v`,
          { e: entityId, o: object, v },
        );
      await row('bge', vec(W_BGE));
      await row('openai', vec(W_OPENAI));
      const [rows] = await db.query<[Array<{ width: number }>]>(
        `SELECT array::len(embedding) AS width FROM knowledge_fact
         WHERE predicate = 'width_probe' ORDER BY width`,
      );
      return ((rows as Array<{ width: number }>) ?? []).map((r) => r.width);
    });
    expect(widths).toEqual([W_BGE, W_OPENAI]);
  });

  it('poisons cosine search for the ENTIRE table, not just the bad row', async () => {
    const surreal = f.app.get(SurrealService);
    const outcome = await surreal.withCompany(f.companyId, async (db) => {
      try {
        // A 1024-wide query against a table holding one 1536-wide row.
        // The mismatched row does not merely rank badly — it aborts the
        // whole query, so a single poisoned row takes down dense search
        // for every other row in the table.
        await db.query(
          `SELECT vector::similarity::cosine(embedding, $q) AS score
           FROM knowledge_fact WHERE predicate = 'width_probe'`,
          { q: vec(W_BGE) },
        );
        return 'no-error';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(outcome).toMatch(/same dimension/i);
  });

  it('blocks HNSW index creation entirely once a mismatched row exists', async () => {
    const surreal = f.app.get(SurrealService);
    const outcome = await surreal.withCompany(f.companyId, async (db) => {
      try {
        // HnswMaintenanceService issues exactly this DDL. A poisoned row
        // makes the index un-buildable, so the tenant cannot be moved onto
        // the fast KNN path until the corpus is cleaned.
        await db.query(
          `DEFINE INDEX ix_width_probe ON knowledge_fact FIELDS embedding
           HNSW DIMENSION ${W_BGE} DIST COSINE EFC 200 M 16`,
        );
        return 'no-error';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await db.query(`REMOVE INDEX IF EXISTS ix_width_probe ON knowledge_fact`);
        await db.query(`DELETE knowledge_fact WHERE predicate = 'width_probe'`);
      }
    });
    expect(outcome).toMatch(/dimension/i);
  });
});
