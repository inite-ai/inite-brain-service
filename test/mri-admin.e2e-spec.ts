/**
 * GET /v1/admin/mri end-to-end:
 *   - a brain:admin token gets the MRI report shape (dimensions + operating
 *     point), parsing against MriReportSchema;
 *   - a non-admin token gets 404 (indistinguishable from "route not deployed" —
 *     the focus-admin / EPISODES_API idiom), never 403;
 *   - no token gets 401.
 *
 * Read-only: the endpoint reads the metrics registry + suite-status ledger; it
 * touches no serving path.
 */
import { AppFixture, createApp } from './app-fixture';
import { MriReportSchema } from '../src/contracts/admin/mri.schema';

jest.setTimeout(120_000);

describe('GET /v1/admin/mri (admin-gated, read-only)', () => {
  let f: AppFixture;
  let nonAdminKey: string;

  beforeAll(async () => {
    f = await createApp({ extraKeys: [{ scopes: ['brain:read'] }] });
    nonAdminKey = f.extraApiKeys[0]!;
  });

  afterAll(async () => {
    await f.close();
  });

  it('returns the MRI report shape for a brain:admin token', async () => {
    const res = await f.http.get('/v1/admin/mri').set({ Authorization: `Bearer ${f.apiKey}` });
    expect(res.status).toBe(200);
    const parsed = MriReportSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new Error(`MRI response drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(typeof parsed.data.generatedAt).toBe('string');
    expect(Object.keys(parsed.data.dimensions).length).toBeGreaterThan(0);
    // Eval-gated dims are honestly pending; structural dims are ledger-backed.
    expect(parsed.data.dimensions.correctness!.value).toBe('pending-eval');
  });

  it('serves the Part 1 operating point for a brain:admin token', async () => {
    const res = await f.http
      .get('/v1/admin/mri/operating-point')
      .set({ Authorization: `Bearer ${f.apiKey}` });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accuracyProxy');
    expect(res.body).toHaveProperty('costPerQueryUpperBound');
    expect(res.body).toHaveProperty('sampleCount');
  });

  it('404s for a non-admin token (indistinguishable from absent)', async () => {
    const res = await f.http.get('/v1/admin/mri').set({ Authorization: `Bearer ${nonAdminKey}` });
    expect(res.status).toBe(404);
  });

  it('401s when unauthenticated', async () => {
    const res = await f.http.get('/v1/admin/mri');
    expect(res.status).toBe(401);
  });
});
