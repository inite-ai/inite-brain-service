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
