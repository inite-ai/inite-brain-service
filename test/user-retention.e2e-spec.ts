/**
 * Retention against a real database: the window is set through the admin
 * route, last contact is read with the real GROUP BY legs, and the erase is
 * the user forget (tombstone included).
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { UserRetentionService } from '../src/entities/user-retention.service';
import { userTombstoneKey } from '../src/common/user-tombstone';

jest.setTimeout(180_000);

describe('user retention', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_user_retention_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const query = <T>(sql: string, vars: Record<string, unknown> = {}) =>
    f.app
      .get(SurrealService)
      .withCompany(f.companyId, async (db) => (await db.query<[T[]]>(sql, vars))[0] ?? []);

  const writeFact = (userId: string, object: string) =>
    f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'user', id: userId },
        predicate: 'city',
        object,
        validFrom: new Date().toISOString(),
        source: { vertical: 'chat' },
        userId,
      });

  it('does nothing while the tenant has no window', async () => {
    const get = await f.http.get('/v1/admin/retention').set(auth());
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ userInactiveDays: null, familyDefaultDays: 730 });
    const run = await f.app.get(UserRetentionService).runTenant(f.companyId);
    expect(run).toMatchObject({ days: null, forgotten: 0 });
  });

  it('refuses a window outside 30..3650 days', async () => {
    const res = await f.http.put('/v1/admin/retention').set(auth()).send({ userInactiveDays: 7 });
    expect(res.status).toBe(400);
  });

  it('forgets a person silent past the window and keeps an active one', async () => {
    expect((await writeFact('u_silent', 'Lisbon')).status).toBe(201);
    expect((await writeFact('u_active', 'Porto')).status).toBe(201);
    // Three years ago: the silent user's last write. Ids first, then
    // UPDATE $ids: an UPDATE … WHERE planned through an index is a silent
    // no-op on SurrealDB 3.2.4 (AGENTS.md ground rule 1).
    const ids = await query<unknown>('SELECT VALUE id FROM knowledge_fact WHERE userId = $u', {
      u: 'u_silent',
    });
    expect(ids.length).toBeGreaterThan(0);
    await query('UPDATE $ids SET recordedAt = time::now() - 1095d', { ids });
    const put = await f.http.put('/v1/admin/retention').set(auth()).send({ userInactiveDays: 730 });
    expect(put.status).toBe(200);
    expect(put.body.userInactiveDays).toBe(730);

    const run = await f.app.get(UserRetentionService).runTenant(f.companyId);
    expect(run).toMatchObject({ days: 730, expired: 1, forgotten: 1, failed: 0 });
    expect(
      await query('SELECT id FROM knowledge_fact WHERE userId = $u', { u: 'u_silent' }),
    ).toHaveLength(0);
    expect(
      await query('SELECT id FROM knowledge_fact WHERE userId = $u', { u: 'u_active' }),
    ).toHaveLength(1);
    const tomb = await query(`SELECT forgottenAt FROM type::record('user_tombstone', $k)`, {
      k: userTombstoneKey(f.companyId, 'u_silent'),
    });
    expect(tomb).toHaveLength(1);
  });
});
