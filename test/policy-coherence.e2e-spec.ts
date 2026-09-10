/**
 * ABAC policy coherence across replicas, against a REAL SurrealDB.
 *
 * PolicyStoreService invalidates the resolver in ITS process; a resolver
 * on another replica used to serve its cached snapshot for up to
 * POLICY_CACHE_TTL_MS (60 s), so a TIGHTENED policy still permitted
 * reads there. Every writer now bumps the tenant's `policy_meta:current`
 * counter (migration 0141) and a resolver re-checks that one row at most
 * every 5 s: a second resolver instance — same database, its own cache,
 * a 10-minute TTL so the TTL cannot be what converges it — sees the
 * tightening within the coherence bound.
 */
import { ConfigService } from '@nestjs/config';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { PolicyStoreService } from '../src/policy/policy-store.service';
import { PolicyResolverService } from '../src/policy/policy-resolver.service';
import type { PolicyDocument } from '../src/policy/policy.types';

const NAME = 'coherence';
const OPEN: PolicyDocument = {
  name: NAME,
  description: '',
  posture: { actions: 'allow', reads: 'allow' },
  mode: 'enforce',
  rules: [],
};
const TIGHT: PolicyDocument = { ...OPEN, posture: { actions: 'deny', reads: 'deny' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ABAC policy tightening reaches a second resolver instance (real SurrealDB)', () => {
  const savedAbac = process.env.ABAC_ENABLED;
  let f: AppFixture;
  let store: PolicyStoreService;
  let replicaB: PolicyResolverService;
  const subject = { keyHash: 'sha256:coherence', claimNames: [NAME] };

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    f = await createApp({ companyId: 'co_policy_coherence_e2e' });
    store = f.app.get(PolicyStoreService);
    replicaB = new PolicyResolverService(
      f.app.get(SurrealService),
      f.app.get(MetricsService),
      new ConfigService({ ABAC_ENABLED: '1', POLICY_CACHE_TTL_MS: '600000' }),
    );
  }, 120_000);

  afterAll(async () => {
    if (f) await f.close();
    if (savedAbac === undefined) delete process.env.ABAC_ENABLED;
    else process.env.ABAC_ENABLED = savedAbac;
  });

  const version = () =>
    f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ version?: number }>]>(
        `SELECT version FROM policy_meta:current`,
      );
      return (rows as Array<{ version?: number }> | undefined)?.[0]?.version ?? 0;
    });

  it('every policy write bumps the tenant coherence counter', async () => {
    expect(await version()).toBe(0);
    await store.create(f.companyId, OPEN, 'operator');
    expect(await version()).toBe(1);
    await store.updateAttachments(f.companyId, NAME, { attach: ['key:sha256:x'], detach: [] });
    expect(await version()).toBe(2);
    await store.updateAttachments(f.companyId, NAME, { attach: [], detach: ['key:sha256:x'] });
    expect(await version()).toBe(3);
  });

  it('a tightened policy is enforced by the other replica within the coherence bound', async () => {
    const before = await replicaB.contextFor(f.companyId, subject);
    expect(before?.sets[0]?.posture).toEqual({ actions: 'allow', reads: 'allow' });

    await store.update(f.companyId, NAME, { body: TIGHT, expectedVersion: 1, updatedBy: 'op' });

    // The writer's own replica is invalidated in-process, at once.
    const local = await f.app.get(PolicyResolverService).contextFor(f.companyId, subject);
    expect(local?.sets[0]?.posture).toEqual({ actions: 'deny', reads: 'deny' });

    // The other replica: its cache is 10 minutes from expiring; the
    // version re-check is what converges it.
    await sleep(5_100);
    const after = await replicaB.contextFor(f.companyId, subject);
    expect(after?.sets[0]?.posture).toEqual({ actions: 'deny', reads: 'deny' });
  }, 30_000);

  it('a removed policy fails closed on the other replica within the bound', async () => {
    await store.remove(f.companyId, NAME);
    await sleep(5_100);
    const after = await replicaB.contextFor(f.companyId, subject);
    // The claim still names the set; it no longer exists → deny-all.
    expect(after?.resolutionError).toBe(true);
    expect(after?.sets[0]?.posture).toEqual({ actions: 'deny', reads: 'deny' });
  }, 30_000);

  it('an unchanged version costs one point read per bound, not a reload', async () => {
    // Spied on the resolver's own two database entry points, not the shared
    // SurrealService: the fixture's crons talk to the same tenant.
    const internals = replicaB as unknown as {
      readVersion: (companyId: string) => Promise<number>;
      loadFresh: (companyId: string) => Promise<unknown>;
    };
    const readVersion = jest.spyOn(internals, 'readVersion');
    const loadFresh = jest.spyOn(internals, 'loadFresh');
    try {
      await replicaB.contextFor(f.companyId, subject);
      await replicaB.contextFor(f.companyId, subject);
      // Both within the bound of the reload above: no database round trip.
      expect(readVersion).not.toHaveBeenCalled();
      await sleep(5_100);
      await replicaB.contextFor(f.companyId, subject);
      // One point read, and the snapshot it validated was reused.
      expect(readVersion).toHaveBeenCalledTimes(1);
      expect(loadFresh).not.toHaveBeenCalled();
    } finally {
      readVersion.mockRestore();
      loadFresh.mockRestore();
    }
  }, 30_000);
});
