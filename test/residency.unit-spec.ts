/**
 * #916 step 3: the residency rule — a tenant is served only by the
 * deployment of its region; a regional cell serves only tenants pinned to
 * it; an unread directory fails closed.
 */
import {
  DEFAULT_REGION,
  MisdirectedTenantError,
  deploymentRegion,
  residencyDecision,
} from '../src/db/residency';
import { ResidencyDirectory } from '../src/db/residency-directory';

describe('residencyDecision', () => {
  it('the default deployment serves unpinned and its own pins, refuses other regions', () => {
    expect(residencyDecision(null, DEFAULT_REGION)).toEqual({ serve: true });
    expect(residencyDecision('default', DEFAULT_REGION)).toEqual({ serve: true });
    expect(residencyDecision('ru', DEFAULT_REGION)).toEqual({ serve: false, region: 'ru' });
  });
  it('a regional cell serves only its own pins', () => {
    expect(residencyDecision('ru', 'ru')).toEqual({ serve: true });
    expect(residencyDecision(null, 'ru')).toEqual({ serve: false, region: null });
    expect(residencyDecision('eu', 'ru')).toEqual({ serve: false, region: 'eu' });
  });
  it('BRAIN_REGION is a region name or empty', () => {
    expect(deploymentRegion({})).toBe(DEFAULT_REGION);
    expect(deploymentRegion({ BRAIN_REGION: 'RU' })).toBe('ru');
    expect(() => deploymentRegion({ BRAIN_REGION: 'r u' })).toThrow();
  });
  it('the refusal is a 421 naming the region and nothing else', () => {
    const e = new MisdirectedTenantError('ru');
    expect(e.getStatus()).toBe(421);
    expect(e.getResponse()).toMatchObject({ region: 'ru' });
  });
});

describe('ResidencyDirectory', () => {
  it('fails closed when the directory has never been read', async () => {
    const dir = new ResidencyDirectory(async () => {
      throw new Error('down');
    }, DEFAULT_REGION);
    await expect(dir.assert('acme')).rejects.toBeInstanceOf(MisdirectedTenantError);
  });
  it('serves from the directory it read', async () => {
    const dir = new ResidencyDirectory(
      async <T>(fn: (db: never) => Promise<T>) =>
        fn({
          query: async () => [[{ companyId: 'ru_co', region: 'ru' }]],
        } as never),
      DEFAULT_REGION,
    );
    await expect(dir.assert('acme')).resolves.toBeUndefined();
    await expect(dir.assert('ru_co')).rejects.toMatchObject({ region: 'ru' });
  });
});
