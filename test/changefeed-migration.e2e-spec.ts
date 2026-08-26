/**
 * 0105_changefeed_overwrite — the migration itself, against SurrealDB v3.2.4.
 *
 * Premise (verified during R4 #92): `DEFINE TABLE IF NOT EXISTS … CHANGEFEED`
 * in 0002 is a FULL no-op on SurrealDB 3.x when 0001 already created the
 * table, so a tenant DB first created under 3.x had no changefeed on the
 * audit-consumed tables. 0105 re-attaches it via DEFINE TABLE OVERWRITE.
 * This suite pins:
 *   1. A freshly-migrated tenant (this testcontainer is 3.x-first by
 *      construction) has a LIVE changefeed on all three drain sources —
 *      with no manual OVERWRITE anywhere in the fixture.
 *   2. Table re-definition did not disturb field machinery: the
 *      canonicalNameLc VALUE field (0002) still computes on create.
 *   3. RE-applying the identical OVERWRITE — what a 2.x-migrated tenant
 *      that already carries the feed experiences when 0105 runs — preserves
 *      the existing changefeed history, so drain cursors survive.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

const SOURCES = ['knowledge_entity', 'knowledge_fact', 'knowledge_edge'] as const;

describe('0105 changefeed overwrite: live feed on a 3.x-first tenant', () => {
  let f: AppFixture;
  let surreal: SurrealService;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_changefeed_mig_e2e' });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const showChanges = (table: (typeof SOURCES)[number]) =>
    surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(
        `SHOW CHANGES FOR TABLE ${table} SINCE 0 LIMIT 100`,
      );
      return (rows as unknown[]) ?? [];
    });

  it('all three drain sources have a live changefeed after migrations alone', async () => {
    // On a table WITHOUT a changefeed SHOW CHANGES throws — before 0105 this
    // loop only passed if the fixture manually re-applied the attribute.
    for (const table of SOURCES) {
      await expect(showChanges(table)).resolves.toBeDefined();
    }
  });

  it('re-applying the identical OVERWRITE preserves history and field machinery', async () => {
    const first = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ canonicalNameLc: unknown }>]>(
        `CREATE knowledge_entity SET type = 'other', canonicalName = 'MixedCase Feed Probe',
           externalRefs = {} RETURN canonicalNameLc`,
      );
      return (rows as Array<{ canonicalNameLc: unknown }>)[0];
    });
    // Field survival: the 0002 VALUE field still computes after the table
    // re-define (OVERWRITE touches table-level attributes only).
    expect(first?.canonicalNameLc).toBe('mixedcase feed probe');

    const beforeReapply = (await showChanges('knowledge_entity')).length;
    expect(beforeReapply).toBeGreaterThanOrEqual(1);

    // The 2.x-migrated-tenant path: the feed is already live and 0105 runs
    // anyway. History recorded before the re-define must remain readable.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        'DEFINE TABLE OVERWRITE knowledge_entity SCHEMAFULL CHANGEFEED 30d INCLUDE ORIGINAL',
      );
      await db.query(
        `CREATE knowledge_entity SET type = 'other', canonicalName = 'Post Reapply Probe',
           externalRefs = {}`,
      );
    });

    const afterReapply = (await showChanges('knowledge_entity')).length;
    expect(afterReapply).toBeGreaterThan(beforeReapply);
  });
});
