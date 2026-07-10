/**
 * Migration 0052 regression — retractedBy='dreams' must pass the field ASSERT.
 *
 * DreamsResolverService.markSuperseded closes the losing side of an aged
 * competing pair with retractedBy='dreams' (src/dreams/resolver.service.ts).
 * The 0001 baseline ASSERT only allowed ['human','system','cascade'], so the
 * very first dreams-resolve write failed the schema assert the moment
 * DREAMS_RESOLVE_ENABLED=1 was switched on — latent in every deploy so far
 * because the flag ships off.
 *
 * This spec replays the exact UPDATE shape markSuperseded issues (no
 * retractedAt — a natural supersede is not a retraction, migration 0033)
 * straight at the schema, then confirms the ASSERT still rejects values
 * outside the widened enum.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { StringRecordId } from 'surrealdb';

describe('migration 0052 — retractedBy accepts the dreams sentinel', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const entity = { vertical: 'rent', id: 'dreams_retract_probe' };

  const ingest = async (predicate: string, object: string) => {
    const res = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: entity,
      predicate,
      object,
      validFrom: new Date().toISOString(),
      source: { vertical: 'rent', eventId: 'auth.profile_created' },
      confidence: 0.9,
    });
    expect(res.body.outcome).toBe('INSERTED');
    return res.body.factId as string;
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_dreams_retract_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it("replays markSuperseded's UPDATE shape and reads the sentinel back", async () => {
    const winnerId = await ingest('name', 'Dreams Retract Probe');
    const loserId = await ingest('status', 'active');

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const loser = new StringRecordId(loserId);
      const winner = new StringRecordId(winnerId);
      await db.query(
        `UPDATE $loser SET
           status = 'superseded',
           retractionReason = 'superseded',
           retractedBy = 'dreams',
           supersededBy = $winner,
           validUntil = $closeAt`,
        { loser, winner, closeAt: new Date() },
      );
      const [rows] = await db.query<[Array<{ retractedBy: string | null }>]>(
        `SELECT retractedBy FROM $loser`,
        { loser },
      );
      expect(
        (rows as Array<{ retractedBy: string | null }>)[0]?.retractedBy,
      ).toBe('dreams');
    });
  });

  it('still rejects values outside the enum', async () => {
    const factId = await ingest('email', 'probe@example.com');

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await expect(
        db.query(`UPDATE $fact SET retractedBy = 'gremlins'`, {
          fact: new StringRecordId(factId),
        }),
      ).rejects.toThrow();
    });
  });
});
