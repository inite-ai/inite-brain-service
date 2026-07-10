import { ConfigService } from '@nestjs/config';
import { PolicyResolverService } from '../src/policy/policy-resolver.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import type { PolicyDocument } from '../src/policy/policy.types';

const DOC: PolicyDocument = {
  name: 'readonly-agent',
  description: '',
  posture: { actions: 'deny', reads: 'allow' },
  mode: 'enforce',
  rules: [
    { id: 'ro', effect: 'allow', kind: 'action', enabled: true, actions: ['@readonly'] },
  ],
};

const DISABLED_DOC: PolicyDocument = {
  ...DOC,
  name: 'switched-off',
  mode: 'disabled',
};

function makeResolver(opts: {
  env?: Record<string, string>;
  policyRows?: Array<{ name: string; mode: string; document: PolicyDocument }>;
  bindingRows?: Array<{ subject: string; policyNames: string[] }>;
} = {}) {
  let queryCalls = 0;
  const surreal = {
    withCompany: async (_companyId: string, fn: (db: unknown) => Promise<unknown>) => {
      queryCalls += 1;
      const db = {
        query: async (sql: string) => {
          if (sql.includes('access_policy')) {
            return [opts.policyRows ?? [{ name: DOC.name, mode: DOC.mode, document: DOC }]];
          }
          return [opts.bindingRows ?? []];
        },
      };
      return fn(db);
    },
  } as unknown as SurrealService;
  const resolutionErrors: number[] = [];
  const metrics = {
    countPolicyResolutionError: () => resolutionErrors.push(1),
  } as unknown as MetricsService;
  const config = new ConfigService({
    ABAC_ENABLED: '1',
    POLICY_CACHE_TTL_MS: '60000',
    ...(opts.env ?? {}),
  });
  const resolver = new PolicyResolverService(surreal, metrics, config);
  return { resolver, resolutionErrors, loads: () => queryCalls };
}

describe('PolicyResolverService', () => {
  it('returns null when ABAC_ENABLED is off — resolver never loads', async () => {
    const { resolver, loads } = makeResolver({ env: { ABAC_ENABLED: '0' } });
    expect(await resolver.contextFor('co_a', 'sha256:k', ['readonly-agent'])).toBeNull();
    expect(loads()).toBe(0);
  });

  it('resolves claim names to compiled sets', async () => {
    const { resolver } = makeResolver();
    const ctx = await resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']);
    expect(ctx).not.toBeNull();
    expect(ctx!.sets).toHaveLength(1);
    expect(ctx!.sets[0].name).toBe('readonly-agent');
    expect(ctx!.resolutionError).toBe(false);
  });

  it('returns null for keys with no bindings and no claims (tombstone, one load per TTL)', async () => {
    const { resolver, loads } = makeResolver();
    expect(await resolver.contextFor('co_a', 'sha256:k1')).toBeNull();
    expect(await resolver.contextFor('co_a', 'sha256:k2')).toBeNull();
    expect(await resolver.contextFor('co_a', 'sha256:k3')).toBeNull();
    expect(loads()).toBe(1);
  });

  it('unions binding-table names with claim names and dedupes', async () => {
    const { resolver } = makeResolver({
      policyRows: [
        { name: DOC.name, mode: DOC.mode, document: DOC },
        { name: 'second', mode: 'enforce', document: { ...DOC, name: 'second' } },
      ],
      bindingRows: [{ subject: 'key:sha256:k', policyNames: ['second', 'readonly-agent'] }],
    });
    const ctx = await resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']);
    expect(ctx!.sets.map((s) => s.name).sort()).toEqual(['readonly-agent', 'second']);
  });

  it('fails closed on an unknown referenced name (deny-all + metric)', async () => {
    const { resolver, resolutionErrors } = makeResolver();
    const ctx = await resolver.contextFor('co_a', 'sha256:k', ['ghost-set']);
    expect(ctx).not.toBeNull();
    expect(ctx!.resolutionError).toBe(true);
    expect(ctx!.sets[0].posture).toEqual({ actions: 'deny', reads: 'deny' });
    expect(ctx!.sets[0].mode).toBe('enforce');
    expect(resolutionErrors).toHaveLength(1);
  });

  it('skips DISABLED sets silently (known name ≠ dangling reference)', async () => {
    const { resolver, resolutionErrors } = makeResolver({
      policyRows: [
        { name: DISABLED_DOC.name, mode: 'disabled', document: DISABLED_DOC },
      ],
    });
    const ctx = await resolver.contextFor('co_a', 'sha256:k', ['switched-off']);
    expect(ctx).toBeNull();
    expect(resolutionErrors).toHaveLength(0);
  });

  it('serves from cache within TTL and reloads after invalidate()', async () => {
    const { resolver, loads } = makeResolver();
    await resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']);
    await resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']);
    expect(loads()).toBe(1);
    resolver.invalidate('co_a');
    await resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']);
    expect(loads()).toBe(2);
  });

  it('dedupes concurrent cold loads (in-flight promise sharing)', async () => {
    const { resolver, loads } = makeResolver();
    await Promise.all([
      resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']),
      resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']),
      resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']),
    ]);
    expect(loads()).toBe(1);
  });

  it('honours ABAC_FORCE_REPORT_ONLY on the context', async () => {
    const { resolver } = makeResolver({ env: { ABAC_FORCE_REPORT_ONLY: '1' } });
    const ctx = await resolver.contextFor('co_a', 'sha256:k', ['readonly-agent']);
    expect(ctx!.forceReportOnly).toBe(true);
  });

  it('caps referenced sets at 8', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `set-${i}`);
    const { resolver } = makeResolver({
      policyRows: many.map((name) => ({
        name,
        mode: 'enforce',
        document: { ...DOC, name },
      })),
    });
    const ctx = await resolver.contextFor('co_a', 'sha256:k', many);
    expect(ctx!.sets.length).toBeLessThanOrEqual(8);
  });
});
