/**
 * User forget erases the rows that are the user's without being memory
 * facts, against a real SurrealDB: the memory tool's verbatim notes
 * (memory_file), the user's links to accounts elsewhere
 * (external_identity) and a pending OAuth state. Another user's rows of
 * the same kinds stay. Before, all of these outlived the user.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('user forget — memory files and account links (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_forget_rows_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const count = (table: string, userId: string) =>
    f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[number[]]>(
        `SELECT VALUE count() FROM type::table($t) WHERE userId = $u GROUP ALL`,
        { t: table, u: userId },
      );
      return rows[0] ?? 0;
    });

  it('erases the user’s notes, identities and OAuth state; another user’s stay', async () => {
    for (const userId of ['u_gone', 'u_kept']) {
      const put = await f.http
        .put('/v1/memory-files')
        .set(auth())
        .send({ path: '/memories/prefs.md', content: `notes of ${userId}`, userId });
      expect(put.status).toBe(200);
      await f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
        await db.query(
          `CREATE external_identity CONTENT { connectionId: 'source_connection:x', externalId: $e, userId: $u };
           CREATE source_oauth_state CONTENT { nonce: $e, provider: 'gdrive', codeVerifier: 'v',
             redirectUri: 'https://brain.example/cb', actor: 'k', userId: $u, expiresAt: time::now() + 1h };`,
          { e: `ext-${userId}`, u: userId },
        );
      });
    }
    for (const t of ['memory_file', 'external_identity', 'source_oauth_state']) {
      expect(await count(t, 'u_gone')).toBe(1);
    }

    const forget = await f.http.post('/v1/users/u_gone/forget').set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body.memoryFilesDeleted).toBe(1);
    expect(forget.body.accountRowsDeleted).toBe(2);

    for (const t of ['memory_file', 'external_identity', 'source_oauth_state']) {
      expect(await count(t, 'u_gone')).toBe(0);
      expect(await count(t, 'u_kept')).toBe(1);
    }
  });
});
