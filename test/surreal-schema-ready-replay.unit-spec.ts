import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../src/db/surreal.service';

/**
 * A tenant whose schema became ready BEFORE a listener subscribed must still
 * reach that listener. On a fresh stand the tenant named by BRAIN_API_KEYS
 * was migrated during Nest bootstrap, before HnswProvisionService's
 * onModuleInit registered its hook — the one notification fired into an
 * empty set, no HNSW index was ever defined, and every KNN query served
 * unranked rows. These tests drive the real ensureSchema with the I/O
 * stubbed out.
 */
describe('SurrealService tenant schema-ready listeners', () => {
  function setup() {
    const svc = new SurrealService(new ConfigService());
    const state = svc as any;
    state.namespace = 'brain';
    const conn = {
      query: jest.fn(async () => [undefined]),
      use: jest.fn(async () => undefined),
    };
    state.migratorConn = conn;
    jest.spyOn(state, 'ensureSession').mockImplementation(async () => conn);
    state.migrator = {
      migrate: jest.fn(async () => ({ applied: ['0001'], alreadyApplied: [] })),
    };
    const ensureSchema = (database: string): Promise<void> => state.ensureSchema(database);
    return { svc, ensureSchema };
  }

  it('replays a tenant migrated before the listener subscribed', async () => {
    const { svc, ensureSchema } = setup();
    await ensureSchema('system');
    await ensureSchema('co_early');
    const seen: string[] = [];
    svc.onTenantSchemaReady((companyId) => seen.push(companyId));
    // `system` is not a tenant — it is never replayed.
    expect(seen).toEqual(['early']);
  });

  it('notifies a listener registered first exactly once per tenant, with no replay double', async () => {
    const { svc, ensureSchema } = setup();
    const seen: string[] = [];
    svc.onTenantSchemaReady((companyId) => seen.push(companyId));
    await ensureSchema('co_late');
    await ensureSchema('co_late');
    expect(seen).toEqual(['late']);
  });

  it('a throwing listener neither breaks registration nor starves its siblings', async () => {
    const { svc, ensureSchema } = setup();
    await ensureSchema('co_a');
    expect(() =>
      svc.onTenantSchemaReady(() => {
        throw new Error('boom');
      }),
    ).not.toThrow();
    const seen: string[] = [];
    svc.onTenantSchemaReady((companyId) => seen.push(companyId));
    await ensureSchema('co_b');
    expect(seen).toEqual(['a', 'b']);
  });
});
