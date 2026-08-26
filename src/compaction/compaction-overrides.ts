/**
 * COMPACTION_TENANT_OVERRIDES — the per-tenant resolution schedule
 * (Brain v2 PR8, docs/roadmap/brain-v2-resolution-2026-08.md).
 *
 * The retention/promotion thresholds were process-global: one
 * COMPACTION_HOT_RETENTION_DAYS for every tenant, one promotion age /
 * group floor for every tenant. This JSON env converts them into a
 * per-tenant schedule, following the RETRIEVAL_PROFILE_OVERRIDES idiom
 * (JSON object mapping companyId → partial override; malformed entries
 * fail open to the process defaults PER TENANT, the JSON shape itself is
 * boot-validated — warn, never throw — in env-validation.ts).
 *
 * Read at call time, not boot: compaction sits outside the engine-gates
 * S5.2 env-read boundary, and a call-time read keeps the schedule
 * runtime-mutable (the cron picks up a changed env on its next run
 * without a restart).
 */
export interface CompactionTenantOverride {
  /** Overrides COMPACTION_HOT_RETENTION_DAYS for this tenant (positive int). */
  hotRetentionDays?: number;
  /** Overrides COMPACTION_PROMOTION_AGE_DAYS for this tenant (positive int). */
  promotionAgeDays?: number;
  /** Overrides COMPACTION_PROMOTION_MIN_GROUP for this tenant (positive int). */
  promotionMinGroup?: number;
  /**
   * Overrides COMPACTION_PROMOTION_MIN_EPISODES for this tenant — the
   * corroboration floor of the promotion consolidation gate (int ≥ 0;
   * 0 = floor off).
   */
  promotionMinEpisodes?: number;
}

const POSITIVE_INT_FIELDS = ['hotRetentionDays', 'promotionAgeDays', 'promotionMinGroup'] as const;

function intField(o: Record<string, unknown>, field: string, min: number): number | undefined {
  const v = o[field];
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : undefined;
}

/**
 * The tenant's validated partial override from COMPACTION_TENANT_OVERRIDES,
 * or {} when the env is absent/malformed or holds no (valid) entry for
 * this tenant. Field-lenient: an out-of-contract field value is dropped
 * (that field falls back to the process default) rather than discarding
 * the tenant's whole entry.
 */
export function compactionOverridesFor(
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): CompactionTenantOverride {
  const raw = env.COMPACTION_TENANT_OVERRIDES;
  if (!raw || !raw.trim()) return {};
  let overrides: unknown;
  try {
    overrides = JSON.parse(raw);
  } catch {
    return {};
  }
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return {};
  const entry = (overrides as Record<string, unknown>)[companyId];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return {};
  const o = entry as Record<string, unknown>;
  const out: CompactionTenantOverride = {};
  for (const field of POSITIVE_INT_FIELDS) {
    const v = intField(o, field, 1);
    if (v !== undefined) out[field] = v;
  }
  // 0 is meaningful here (= corroboration floor off for this tenant).
  const minEpisodes = intField(o, 'promotionMinEpisodes', 0);
  if (minEpisodes !== undefined) out.promotionMinEpisodes = minEpisodes;
  return out;
}
