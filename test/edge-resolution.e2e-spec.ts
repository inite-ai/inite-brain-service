/**
 * Edges in fact resolution (#834) against a REAL SurrealDB, through the
 * harness work path (take → verdicts → submit). Both shapes from the
 * report: a relation replaced on its subject (`lives_in`) and on its
 * object (`leads`), plus valid-time precedence for a late-arriving older
 * relation and a system of record's edge, which no judgement closes.
 */
import { StringRecordId } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { FactResolutionService } from '../src/dreams/fact-resolution.service';
import { verifyWorkToken, type ResolutionTokenPayload } from '../src/common/harness-work-token';

describe('edge resolution — take, judge, apply (real SurrealDB)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_edge_resolution_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const db = <T>(fn: (d: import('surrealdb').Surreal) => Promise<T>) =>
    f.app.get(SurrealService).withCompany(f.companyId, fn);

  const entity = (name: string) =>
    db(async (d) => {
      const [rows] = await d.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity CONTENT { type: 'other', canonicalName: $name }`,
        { name },
      );
      return String(rows[0]!.id);
    });

  const edge = (from: string, kind: string, to: string, validFrom: string, source = {}) =>
    db(async (d) => {
      const [rows] = await d.query<[Array<{ id: unknown }>]>(
        `RELATE $from->knowledge_edge->$to CONTENT {
           kind: $kind, weight: 1, validFrom: $vf,
           source: $source
         } RETURN AFTER`,
        {
          from: new StringRecordId(from),
          to: new StringRecordId(to),
          kind,
          vf: new Date(validFrom),
          source: { vertical: 'chat', ...source },
        },
      );
      return String(rows[0]!.id);
    });

  const state = (id: string) =>
    db(async (d) => {
      const [rows] = await d.query<
        [Array<{ validUntil?: unknown; invalidatedAt?: unknown; resolutionCheckedAt?: unknown }>]
      >(`SELECT validUntil, invalidatedAt, resolutionCheckedAt FROM $id`, {
        id: new StringRecordId(id),
      });
      return rows[0]!;
    });

  /**
   * Answer every candidate of every pending item with `verdict` until
   * nothing is pending: an edge taken as another's candidate waits for the
   * next batch. Returns the prompts the judge was shown.
   */
  const judgeAll = async (verdict: string) => {
    const svc = f.app.get(FactResolutionService);
    const shown: string[] = [];
    for (let round = 0; round < 5; round++) {
      const work = await svc.take(f.companyId);
      if (!work) break;
      shown.push(work.userContent);
      const v = verifyWorkToken(work.token);
      const payload = (v as { payload: ResolutionTokenPayload }).payload;
      const result = {
        items: payload.f.map(([, candidates], i) => ({
          item: `r${i + 1}`,
          verdicts: candidates.map((_, j) => ({ candidate: `c${j + 1}`, verdict })),
        })),
      };
      await svc.submit(f.companyId, payload, result);
    }
    expect(shown.length).toBeGreaterThan(0);
    return shown.join('\n');
  };

  it('a relation replaced on its subject closes at the new one’s start (lives_in)', async () => {
    const sasha = await entity('Sasha');
    const lisbon = await entity('Lisbon');
    const porto = await entity('Porto');
    const old = await edge(sasha, 'lives_in', lisbon, '2026-09-01');
    const now = await edge(sasha, 'lives_in', porto, '2026-10-10');
    const shown = await judgeAll('replaces');
    expect(shown).toContain('lives_in: Sasha → Lisbon');

    const closed = await state(old);
    expect(String(closed.validUntil)).toContain('2026-10-10');
    expect(closed.invalidatedAt).toBeDefined();
    expect((await state(now)).validUntil).toBeUndefined();
  });

  it('a relation replaced on its object closes too (leads)', async () => {
    const diego = await entity('Diego');
    const marta = await entity('Marta');
    const report = await entity('Report');
    const old = await edge(diego, 'leads', report, '2026-01-01');
    const now = await edge(marta, 'leads', report, '2026-08-01');
    await judgeAll('replaces');
    expect(String((await state(old)).validUntil)).toContain('2026-08-01');
    expect((await state(now)).validUntil).toBeUndefined();
  });

  it('valid time decides, not arrival: an older relation that arrives late goes to history', async () => {
    const ana = await entity('Ana');
    const berlin = await entity('Berlin');
    const munich = await entity('Munich');
    const current = await edge(ana, 'lives_in', munich, '2026-06-01');
    const older = await edge(ana, 'lives_in', berlin, '2026-02-01');
    await judgeAll('replaces');
    expect(String((await state(older)).validUntil)).toContain('2026-06-01');
    expect((await state(current)).validUntil).toBeUndefined();
  });

  it("a system of record's relation is never closed by a judgement", async () => {
    const acme = await entity('Acme');
    const kim = await entity('Kim');
    const lee = await entity('Lee');
    const crm = await edge(acme, 'account_owner', kim, '2026-01-01', { kind: 'source_record' });
    const said = await edge(acme, 'account_owner', lee, '2026-05-01');
    await judgeAll('replaces');
    expect((await state(crm)).validUntil).toBeUndefined();
    expect((await state(said)).resolutionCheckedAt).toBeDefined();
  });

  it('an edge with nothing to compare against is marked judged without a call', async () => {
    const solo = await entity('Solo');
    const town = await entity('Town');
    const lone = await edge(solo, 'lives_in', town, '2026-01-01');
    const svc = f.app.get(FactResolutionService);
    expect(await svc.take(f.companyId)).toBeNull();
    expect((await state(lone)).resolutionCheckedAt).toBeDefined();
  });
});
