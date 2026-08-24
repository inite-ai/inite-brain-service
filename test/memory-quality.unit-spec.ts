/**
 * MemoryQualityService — the nightly cross-tenant snapshot lands in the
 * Prometheus gauges: counts sum across tenants, a failing tenant is
 * skipped (partial snapshot beats no snapshot), absent statuses export
 * as 0 so no stale series linger between passes.
 */
import { MetricsService } from '../src/metrics/metrics.service';
import { MemoryQualityService } from '../src/metrics/memory-quality.service';

// Canned per-tenant counts, routed on query shape (mirrors the service's
// query set: status GROUP BY, stale buckets, trust bands, orphan legs).
const tenantDb = {
  query: async (sql: string, params?: Record<string, unknown>) => {
    if (sql.includes('GROUP BY status')) {
      return [
        [
          { status: 'active', n: 10 },
          { status: 'competing', n: 3 },
          { status: 'superseded', n: 5 },
        ],
      ];
    }
    if (sql.includes('recordedAt < type::datetime($cutoff)')) {
      const days = Math.round((Date.now() - Date.parse(params?.cutoff as string)) / 86_400_000);
      return [[{ n: days === 30 ? 6 : days === 90 ? 4 : 1 }]];
    }
    if (sql.includes('< 0.4')) return [[{ n: 2 }]];
    if (sql.includes('> 0.6')) return [[{ n: 3 }]];
    if (sql.includes('GROUP BY entityId')) return [[{ n: 6 }]];
    if (sql.includes('knowledge_entity')) return [[{ n: 8 }]];
    if (sql.includes('access_policy')) return [[{ n: 2 }]];
    throw new Error(`unexpected query: ${sql}`);
  },
};

describe('MemoryQualityService', () => {
  it('aggregates per-tenant counts into gauges, skipping failed tenants', async () => {
    const metrics = new MetricsService();
    const surreal = {
      withCompany: async (companyId: string, fn: (db: typeof tenantDb) => Promise<unknown>) => {
        if (companyId === 'co_broken') throw new Error('boom');
        return fn(tenantDb);
      },
    };
    const apiKeys = { knownCompanyIds: () => ['co_a', 'co_b', 'co_broken'] };
    const svc = new MemoryQualityService(surreal as never, apiKeys as never, metrics);

    const snapshot = await svc.collectNow();

    // Two healthy tenants with identical canned counts; co_broken skipped.
    expect(snapshot.factsByStatus).toMatchObject({
      active: 20,
      competing: 6,
      superseded: 10,
    });
    expect(snapshot.staleActiveFacts).toMatchObject({ 30: 12, 90: 8, 365: 2 });
    // Per tenant: low=2, high=3, neutral = 10 active − 2 − 3 = 5.
    expect(snapshot.trustBands).toEqual({ low: 4, high: 6, neutral: 10 });
    // Per tenant: 8 unmerged entities − 6 with an active fact = 2 orphans.
    expect(snapshot.orphanEntities).toBe(4);
    // Per tenant: 2 sets in force (enforce or report_only).
    expect(snapshot.policySetsActive).toBe(4);

    const { body } = await metrics.serialize();
    expect(body).toContain('brain_memory_facts{status="competing"} 6');
    expect(body).toContain('brain_memory_stale_active_facts{older_than_days="90"} 8');
    expect(body).toContain('brain_memory_fact_trust{band="low"} 4');
    expect(body).toContain('brain_memory_fact_trust{band="neutral"} 10');
    expect(body).toContain('brain_memory_orphan_entities 4');
    expect(body).toContain('brain_policy_sets_active 4');
    // Statuses with no rows still export — as 0, not as a missing series.
    expect(body).toContain('brain_memory_facts{status="retracted"} 0');
  });
});
