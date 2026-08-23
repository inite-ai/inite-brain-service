/**
 * Artifacts × per-user scope (migration 0055) against a REAL SurrealDB.
 *
 * fn::active_facts_for (migration 0003) had no userId filter, so a
 * personal fact attached to a SHARED entity (bare-entityId + userId)
 * used to compile into the tenant-wide knowledge_artifact and serve to
 * any brain:read caller — and user-forget never purged the dossier.
 * This pins both: the personal fact stays out of the compiled artifact,
 * and forget takes the artifact with it.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { ArtifactsService } from '../src/artifacts/artifacts.service';

describe('artifacts respect per-user scope', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const scopes = ['brain:read', 'brain:read_pii'] as never;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_artifact_scope_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingest = async (body: Record<string, unknown>) => {
    const r = await f.http.post('/v1/ingest/fact').set(auth()).send({
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
      ...body,
    });
    expect([200, 201]).toContain(r.status);
    return r.body;
  };

  it('excludes personal facts from the compiled dossier, and forget purges it', async () => {
    // Global name on a shared entity.
    const anchor = await ingest({
      entityRef: { vertical: 'rent', id: 'artifact_shared_subject' },
      predicate: 'name',
      object: 'Public Shared Name',
    });
    const surreal = f.app.get(SurrealService);
    const entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: (anchor.factId as string).split(':')[1] },
      );
      return String((rows as Array<{ entityId: unknown }>)[0]!.entityId);
    });

    // Personal name on the SAME shared entity (bare-entityId + userId).
    await ingest({
      entityRef: { entityId },
      predicate: 'name',
      object: 'Personal Secret Name',
      userId: 'user_art',
    });

    const artifacts = f.app.get(ArtifactsService);
    const built = await artifacts.getArtifact({
      companyId: f.companyId,
      entityIdRaw: entityId,
      artifactType: 'customer_profile',
      scopes,
    });
    const serialized = JSON.stringify(built);
    expect(serialized).toContain('Public Shared Name');
    expect(serialized).not.toContain('Personal Secret Name');

    // The dossier row now exists; user-forget must take it.
    const beforeCount = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM knowledge_artifact
           WHERE entityId = type::record('knowledge_entity', $tail) GROUP ALL`,
        { tail: entityId.split(':')[1] },
      );
      return (rows as Array<{ n: number }>)[0]?.n ?? 0;
    });
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    const forget = await f.http
      .post('/v1/users/user_art/forget')
      .set(auth())
      .send({});
    expect([200, 201]).toContain(forget.status);

    const afterCount = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM knowledge_artifact
           WHERE entityId = type::record('knowledge_entity', $tail) GROUP ALL`,
        { tail: entityId.split(':')[1] },
      );
      return (rows as Array<{ n: number }>)[0]?.n ?? 0;
    });
    expect(afterCount).toBe(0);
  });
});
