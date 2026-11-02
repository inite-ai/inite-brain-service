/**
 * The tenant a model call is charged to (common/tenant-context.ts). Ground
 * rule 2: one tenant's scope must never leak into another's — concurrent
 * scopes each read their own, nested scopes restore on exit.
 */
import { currentTenant, runWithTenant } from '../src/common/tenant-context';
import { runWithRequestContext } from '../src/common/request-context';

const tick = () => new Promise((r) => setImmediate(r));

describe('tenant context', () => {
  it('is undefined outside any scope', () => {
    expect(currentTenant()).toBeUndefined();
  });

  it('two concurrent tenants never see each other', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const work = (id: string) =>
      runWithTenant(id, async () => {
        for (let i = 0; i < 20; i++) {
          await tick();
          seen.push([id, currentTenant()]);
        }
      });
    await Promise.all([work('co_a'), work('co_b'), work('co_c')]);
    expect(seen).toHaveLength(60);
    for (const [expected, actual] of seen) expect(actual).toBe(expected);
  });

  it('a nested scope wins inside and restores the outer one after', async () => {
    await runWithTenant('outer', async () => {
      await runWithTenant('inner', async () => {
        await tick();
        expect(currentTenant()).toBe('inner');
      });
      expect(currentTenant()).toBe('outer');
    });
    expect(currentTenant()).toBeUndefined();
  });

  it('falls back to the guarded request tenant, and a tenant scope overrides it', async () => {
    await runWithRequestContext({ correlationId: 'r1', companyId: 'co_req' }, async () => {
      expect(currentTenant()).toBe('co_req');
      await runWithTenant('co_job', async () => {
        await tick();
        expect(currentTenant()).toBe('co_job');
      });
      expect(currentTenant()).toBe('co_req');
    });
  });
});
