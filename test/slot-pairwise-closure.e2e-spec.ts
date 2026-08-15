/**
 * Behavioral confirm of migration 0085 against a REAL SurrealDB — the
 * non-transitive triangle that 0084 mishandled (audit F1/F3):
 *
 *   A (day 1) and B (day 5) both sit ≥ the slot cosine gate to the
 *   incoming C (day 5) but < the gate to EACH OTHER — so each earlier
 *   resolve saw an empty pool and both stayed active. C must close A
 *   (strictly earlier day) and flip B to COMPETING (same-day
 *   ambiguity) — regardless of which of them scores as best_opp.
 *
 *   Then D (day 9) must close the whole slot — including the COMPETING
 *   B that 0084's 'active'-only pool would have left open forever (F3).
 *
 * Vectors: 2-d unit vectors at 0° (A), 50° (B), 25° (C/D-ish) give
 * cos(A,C)=cos(B,C)≈0.906 ≥ 0.9 gate and cos(A,B)≈0.643 < gate.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

const deg = (d: number): number[] => [
  Math.cos((d * Math.PI) / 180),
  Math.sin((d * Math.PI) / 180),
];

describe('0085 pairwise closure + competing re-admission (real SurrealDB)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_slot_0085_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('closes earlier-day, competes same-day, and a later update closes the pair', async () => {
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE knowledge_entity:slot_subj SET
           type = 'staff', canonicalName = 'Slot Subject',
           canonicalNameLc = 'slot subject'`,
      );
      const resolve = async (
        object: string,
        day: string,
        embedding: number[],
      ): Promise<{
        outcome: string;
        factId: unknown;
        supersededFactIds?: unknown[];
        competingFactIds?: unknown[];
      }> => {
        const [r] = await db.query<[never]>(
          `RETURN fn::resolve_fact(
            type::record('knowledge_entity', 'slot_subj'),
            'status_update', $object, NONE, $embedding,
            0.9, type::datetime($day), NONE, { vertical: 'work', recorder: 'deriver', conversationId: 'conv1' },
            0.6, 'bitemporal_event', 0.85,
            0.30, 0.40, 0.20, 0.10,
            0.30, 0.15,
            NONE, NONE, NONE, NONE, 'wdtest',
            NONE, 0.9
          )`,
          { object, embedding, day: `${day}T00:00:00Z` },
        );
        return r;
      };

      const a = await resolve('joined the platform team', '2026-01-01', deg(0));
      expect(a.outcome).toBe('INSERTED');
      // B is under the gate vs A → sees an empty pool, stays active.
      const b = await resolve('leads the infra guild', '2026-01-05', deg(50));
      expect(b.outcome).toBe('INSERTED');

      // C: same day as B, later than A, ≥ gate to BOTH.
      const c = await resolve('moved to the infra org', '2026-01-05', deg(25));
      expect(c.outcome).toBe('SUPERSEDED');
      expect((c.supersededFactIds ?? []).map(String)).toEqual([
        String(a.factId),
      ]);
      expect((c.competingFactIds ?? []).map(String)).toEqual([
        String(b.factId),
      ]);

      const [bRow] = await db.query<[Array<{ status: string }>]>(
        `SELECT status FROM ONLY $id`,
        { id: b.factId },
      );
      expect((bRow as unknown as { status: string }).status).toBe('competing');

      // D: strictly later day, ≥ gate to B and C (25°↔50° = 0.906;
      // vs A it is under the gate but A is already closed).
      const d = await resolve('now heads infrastructure', '2026-01-09', deg(40));
      expect(d.outcome).toBe('SUPERSEDED');
      const closed = (d.supersededFactIds ?? []).map(String).sort();
      // F3: the COMPETING B re-entered the pool and is now closed
      // alongside the active C (both < gate to each other is not the
      // case here — both are within 15-25° of D).
      expect(closed).toEqual([String(b.factId), String(c.factId)].sort());
      expect(d.competingFactIds ?? []).toHaveLength(0);

      const [open] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_fact
          WHERE entityId = knowledge_entity:slot_subj
            AND status = 'active'`,
      );
      expect((open ?? []).map((r) => String(r.id))).toEqual([
        String(d.factId),
      ]);
    });
  }, 60_000);
});
