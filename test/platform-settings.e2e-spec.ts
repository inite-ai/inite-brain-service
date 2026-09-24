import { AppFixture, createApp } from './app-fixture';
import { PlatformSettingsService } from '../src/admin/platform-settings.service';

/**
 * Configuration the operator can actually reach: a value set through
 * /v1/admin/config lands in the service's own environment, is reported as
 * an override with the deploy's value beneath it, reaches a second replica
 * on its refresh, and disappears again when cleared.
 *
 * Two app boots against the same SurrealDB stand in for two replicas, the
 * way admin-baselines-replica does.
 */
jest.setTimeout(180_000);

const KEY = 'RETRIEVAL_VERIFIER_MODEL';

describe('the operator sets configuration from the admin surface', () => {
  let a: AppFixture;
  let b: AppFixture;
  const deployValue = 'gpt-5.6-luna';

  beforeAll(async () => {
    process.env[KEY] = deployValue;
    a = await createApp();
    b = await createApp();
  });

  afterAll(async () => {
    await a.http.delete(`/v1/admin/config/${KEY}`).set('Authorization', `Bearer ${a.apiKey}`);
    await b.close();
    await a.close();
    delete process.env[KEY];
  });

  it('a set value applies at once, shows what it replaced, and reverts', async () => {
    const before = await a.http
      .get('/v1/admin/config')
      .set('Authorization', `Bearer ${a.apiKey}`)
      .expect(200);
    const entryOf = (body: { entries: { key: string }[] }) =>
      body.entries.find((e) => e.key === KEY) as Record<string, unknown>;
    expect(entryOf(before.body)).toMatchObject({ overridden: false, settable: true });

    const set = await a.http
      .put(`/v1/admin/config/${KEY}`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send({ value: 'gpt-6-luna', note: 'measured on the stand' })
      .expect(200);
    expect(set.body).toMatchObject({ key: KEY, outcome: 'set' });
    // The process this request reached sees it immediately.
    expect(process.env[KEY]).toBe('gpt-6-luna');

    const after = await a.http
      .get('/v1/admin/config')
      .set('Authorization', `Bearer ${a.apiKey}`)
      .expect(200);
    expect(entryOf(after.body)).toMatchObject({
      overridden: true,
      currentValue: 'gpt-6-luna',
      deployValue,
      note: 'measured on the stand',
    });

    // The other replica is not told; it finds out on its next read.
    await b.app.get(PlatformSettingsService).refresh();
    expect(process.env[KEY]).toBe('gpt-6-luna');

    const cleared = await a.http
      .delete(`/v1/admin/config/${KEY}`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .expect(200);
    expect(cleared.body).toMatchObject({ key: KEY, outcome: 'cleared' });
    expect(process.env[KEY]).toBe(deployValue);

    const gone = await a.http
      .delete(`/v1/admin/config/${KEY}`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .expect(200);
    expect(gone.body).toMatchObject({ outcome: 'absent' });
  });

  it('refuses a key that is not catalogued, a bootstrap key, and a flag that is not a flag', async () => {
    const auth = { Authorization: `Bearer ${a.apiKey}` };
    const unknown = await a.http.put('/v1/admin/config/NOT_A_KNOB').set(auth).send({ value: '1' });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('not a catalogued setting');

    // Catalogued, and still refused: the key the store's own secrets are
    // encrypted under cannot be moved into the store.
    const bootstrap = await a.http
      .put('/v1/admin/config/SOURCE_CREDENTIAL_ENCRYPTION_KEY')
      .set(auth)
      .send({ value: Buffer.alloc(32, 1).toString('base64') });
    expect(bootstrap.status).toBe(400);
    expect(JSON.stringify(bootstrap.body)).toContain('environment-only');

    const notAFlag = await a.http
      .put('/v1/admin/config/SOURCE_PLANE_ENABLED')
      .set(auth)
      .send({ value: 'yes please' });
    expect(notAFlag.status).toBe(400);
    expect(JSON.stringify(notAFlag.body)).toContain('0, 1, true or false');
  });

  it('a secret is stored encrypted and never handed back', async () => {
    const auth = { Authorization: `Bearer ${a.apiKey}` };
    const secretKey = 'SOURCE_OAUTH_GOOGLE_CLIENT_SECRET';
    const previous = process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    try {
      await a.http
        .put(`/v1/admin/config/${secretKey}`)
        .set(auth)
        .send({ value: 'top-secret' })
        .expect(200);
      expect(process.env[secretKey]).toBe('top-secret');

      const list = await a.http.get('/v1/admin/config').set(auth).expect(200);
      const body = JSON.stringify(list.body);
      expect(body).not.toContain('top-secret');
      const entry = (list.body.entries as { key: string }[]).find(
        (e) => e.key === secretKey,
      ) as Record<string, unknown>;
      expect(entry).toMatchObject({ overridden: true, secret: true, currentValue: '••• set' });

      const rows = await a.app.get(PlatformSettingsService).list();
      expect(rows.find((r) => r.key === secretKey)).toMatchObject({ secret: true, value: null });
    } finally {
      await a.http.delete(`/v1/admin/config/${secretKey}`).set(auth);
      if (previous === undefined) delete process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = previous;
    }
  });
});
