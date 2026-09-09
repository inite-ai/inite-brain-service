/**
 * Recompose changefeed cursor against a REAL SurrealDB — regression for the
 * nightly `recompose` job failing on every run since the 3.1.5 upgrade with
 * `CborNumberError: Number too big to be encoded`.
 *
 * A 3.x `SHOW CHANGES` versionstamp is a u64 (~1.17e17, above
 * Number.MAX_SAFE_INTEGER). `invalidate()` funnelled it through Number()
 * and then bound the result into the cursor UPSERT, which the SDK refuses to
 * encode. The unit suite stubs small integers and no e2e drove
 * `invalidate()` against the real changefeed, so CI never saw it — the same
 * blind spot as the compaction `d$cutoff` regression (compaction.e2e-spec).
 *
 * The drain must (1) not throw, (2) leave the cursor at the real u64 stamp,
 * (3) be a no-op on the next run — SINCE is inclusive, so a cursor that was
 * rounded or truncated would re-mark the same change forever.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { RecomposeService } from '../src/compaction/recompose.service';

const CURSOR = 'recompose:knowledge_fact';

describe('recompose changefeed cursor (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_recompose_cursor_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  async function cursorValue(): Promise<bigint | null> {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ lastVersionstamp: number | bigint }>]>(
        `SELECT lastVersionstamp FROM changefeed_state WHERE source = $s LIMIT 1`,
        { s: CURSOR },
      );
      const row = (rows as Array<{ lastVersionstamp: number | bigint }>)[0];
      return row ? BigInt(row.lastVersionstamp) : null;
    });
  }

  it('drains a u64 versionstamp without throwing, and the next run is a no-op', async () => {
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'recompose_cursor_subject' },
        predicate: 'claim_probe',
        object: 'a claim whose retraction lands on the changefeed',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(ingest.status);
    const factId = ingest.body.factId as string;

    // A content change the drain must act on (not merely skip): the fact
    // goes 'retracted', which is in CONTENT_CHANGED, so invalidate() takes
    // the mark_derived_stale + advanceCursor path — the one that threw.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE type::record('knowledge_fact', $tail)
           SET status = 'retracted', retractedAt = time::now()`,
        { tail: factId.split(':')[1] },
      );
    });

    const recompose = f.app.get(RecomposeService);
    await expect(recompose.invalidate(f.companyId)).resolves.toBeGreaterThanOrEqual(0);

    const after = await cursorValue();
    expect(after).not.toBeNull();
    // The stamp the server actually issues — a u64 the old Number() path
    // could neither represent nor re-encode. If this ever fails with a small
    // value, the stand's versionstamp scheme changed, not the drain.
    expect(after! > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    // Idempotent: SINCE is inclusive of the cursor, so the same change is
    // skipped and the cursor does not move (a rounded cursor would re-drain).
    await expect(recompose.invalidate(f.companyId)).resolves.toBe(0);
    expect(await cursorValue()).toBe(after);
  });
});
