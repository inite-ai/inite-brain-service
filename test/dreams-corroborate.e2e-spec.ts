/**
 * Fuzzy-corroboration apply path against a REAL SurrealDB: the
 * LET/UPDATE statement replays migration 0051's corroboration shape —
 * younger row → status='corroborating' pointing at the incumbent,
 * incumbent's accumulator unioned by origin (count = distinct origins,
 * idempotent for a repeated origin). The pair-finding/LLM half is
 * covered by the unit spec; this validates the SurrealQL that the unit
 * stubs cannot.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { DreamsCorroborateService } from '../src/dreams/corroborate.service';

describe('dreams corroborate — apply statement (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_corrob_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingest = async (object: string, recorder: string) => {
    const res = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'corrob_subject' },
      predicate: 'claim_probe',
      object,
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder },
    });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  };

  it('retags the younger row and bumps the incumbent with origin-dedup', async () => {
    // Different wording → stub embeddings diverge → both land active
    // (no ingest-time corroboration to get in the way).
    const incumbentId = await ingest('gold tier customer', 'bot_a');
    const youngerId = await ingest('customer on the gold tier', 'bot_b');
    expect(youngerId).not.toBe(incumbentId);

    const svc = f.app.get(DreamsCorroborateService);
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const apply = () =>
        (
          svc as unknown as {
            applyCorroboration: (
              db: unknown,
              pair: { incumbent: { id: string }; younger: { id: string } },
            ) => Promise<void>;
          }
        ).applyCorroboration(db, {
          incumbent: { id: incumbentId },
          younger: { id: youngerId },
        });
      await apply();

      const [youngerRows] = await db.query<
        [Array<{ status: string; corroborates: unknown }>]
      >(
        `SELECT status, corroborates FROM type::record('knowledge_fact', $tail)`,
        { tail: youngerId.split(':')[1] },
      );
      const younger = (
        youngerRows as Array<{ status: string; corroborates: unknown }>
      )[0]!;
      expect(younger.status).toBe('corroborating');
      expect(String(younger.corroborates)).toBe(incumbentId);

      const readIncumbent = async () => {
        const [rows] = await db.query<
          [
            Array<{
              corroboration: {
                count: number;
                originKeys: string[];
                sourceKeys: string[];
              };
            }>,
          ]
        >(
          `SELECT corroboration FROM type::record('knowledge_fact', $tail)`,
          { tail: incumbentId.split(':')[1] },
        );
        return (
          rows as Array<{
            corroboration: {
              count: number;
              originKeys: string[];
              sourceKeys: string[];
            };
          }>
        )[0]!.corroboration;
      };

      const first = await readIncumbent();
      expect(first.count).toBe(1);
      expect(first.originKeys).toEqual(['rent:bot_b']);
      expect(first.sourceKeys).toEqual(['rent:bot_b']);

      // Re-applying the SAME origin must not inflate the count (0051).
      await apply();
      const second = await readIncumbent();
      expect(second.count).toBe(1);
      expect(second.originKeys).toEqual(['rent:bot_b']);
    });
  });
});
