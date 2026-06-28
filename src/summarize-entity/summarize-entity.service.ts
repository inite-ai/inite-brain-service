import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EntitiesService } from '../entities/entities.service';
import { BrainScope } from '../auth/api-key.types';

/**
 * summarize_entity — one-liner-per-entity surface for LLM context.
 *
 * Agents that load an entity into context today fan out three calls —
 * profile + timeline + (sometimes) get_competing_facts — and then
 * stitch the result into a short briefing. This service does that
 * stitching server-side and caches the output so a hot entity touched
 * across many turns doesn't burn the same compute.
 *
 * v1 design choices:
 *   - Template-based rendering, NO LLM call. The styleHint axis is
 *     wire-shape-preserved so we can swap in an LLM-backed generator
 *     behind a feature flag without breaking callers.
 *   - In-process LRU cache (500 entries by default). Cheap to add,
 *     hot entities benefit. Cross-instance cache + DB-backed
 *     `compacted_entity` table is a v2 lift — note `Gotcha` in the
 *     roadmap brief: an LLM-backed generator pushes us toward
 *     persistent cache, but until that lands the LRU is enough.
 *   - Invalidation: WATERMARK-based (borrowed from graphiti
 *     `summarize_saga`). Each cache entry stores the entity's wall-clock
 *     watermark (max recordedAt) at build time. Every lookup runs a cheap
 *     indexed aggregate (EntitiesService.freshnessWatermark); if a fact
 *     with a newer recordedAt has landed since — including a BACKFILLED
 *     one whose validFrom is in the past — the entry is treated as stale
 *     and rebuilt. The cache key still embeds asOf, so historical cursors
 *     stay isolated; the watermark adds the missing freshness axis the
 *     prior LRU-only design could not see.
 *   - The result also carries `asOfValid` — the event-time (max validFrom)
 *     the summary reflects, so the caller knows "as of when", not just
 *     "computed when".
 */
@Injectable()
export class SummarizeEntityService {
  private readonly logger = new Logger(SummarizeEntityService.name);
  private readonly cache = new Map<string, CachedSummary>();
  private readonly maxEntries = 500;

  constructor(private readonly entities: EntitiesService) {}

  async summarize(
    companyId: string,
    args: SummarizeArgs,
    scopes: BrainScope[],
  ): Promise<SummarizeResult> {
    const cacheKey = buildCacheKey(companyId, args);
    // Freshness probe FIRST — one cheap indexed aggregate. Its wall-clock
    // watermark decides whether a cache hit is still valid.
    const watermark = await this.entities.freshnessWatermark({
      companyId,
      entityIdRaw: args.entityId,
      asOfRaw: args.asOf,
      scopes,
    });

    const hit = this.cache.get(cacheKey);
    if (hit && !isStale(hit.watermark, watermark.maxRecordedAt)) {
      // LRU touch — re-insert moves the key to end-of-iteration.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return { ...hit.result, cached: true };
    }
    if (hit) this.cache.delete(cacheKey); // stale — drop and rebuild below.

    const profile = await this.entities.getProfile({
      companyId,
      entityIdRaw: args.entityId,
      asOfRaw: args.asOf,
      scopes,
    });

    const style = args.styleHint ?? 'neutral';
    const summary = renderSummary(profile, style);
    const result: SummarizeResult = {
      entityId: profile.entityId,
      summary,
      factsConsidered: profile.facts.length,
      style,
      asOf: args.asOf,
      asOfValid: watermark.maxValidFrom ?? undefined,
      cached: false,
    };
    const cacheable: CachedSummary = {
      key: cacheKey,
      result: {
        entityId: result.entityId,
        summary: result.summary,
        factsConsidered: result.factsConsidered,
        style: result.style,
        asOf: result.asOf,
        asOfValid: result.asOfValid,
      },
      watermark: watermark.maxRecordedAt,
      insertedAt: Date.now(),
    };
    this.cache.set(cacheKey, cacheable);
    this.evictIfNeeded();

    this.logger.debug(
      `[summarize_entity] companyId=${companyId} entity=${profile.entityId} facts=${profile.facts.length} style=${style}`,
    );
    return result;
  }

  /**
   * Test-only escape hatch — drops the in-memory LRU. Production
   * callers never need to invoke this; cache entries age out via the
   * 500-entry tail and asOf-keyed misses.
   */
  clearCacheForTest(): void {
    this.cache.clear();
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

/**
 * A cached summary is stale when the entity's current wall-clock
 * watermark differs from the one captured at build time. recordedAt only
 * advances as facts land, so "differs" means "newer fact arrived" — the
 * proactive invalidation the old LRU-only cache lacked. Both-null (entity
 * with no facts) is fresh.
 */
function isStale(
  builtWatermark: string | null,
  currentWatermark: string | null,
): boolean {
  return (builtWatermark ?? '') !== (currentWatermark ?? '');
}

function buildCacheKey(companyId: string, args: SummarizeArgs): string {
  const asOf = args.asOf ?? 'now';
  const style = args.styleHint ?? 'neutral';
  const raw = `${companyId}::${args.entityId}::${asOf}::${style}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function renderSummary(
  profile: {
    canonicalName: string;
    type: string;
    externalRefs: Record<string, string>;
    facts: Array<{
      predicate: string;
      object: string;
      confidence: number;
      validFrom: string;
      status: string;
    }>;
  },
  style: SummarizeStyle,
): string {
  if (profile.facts.length === 0) {
    return `${profile.canonicalName} (${profile.type}). No active facts on record.`;
  }
  // Pick the 6 most-confident active facts to seed the line — past
  // that returns hit the embedding truncation point anyway.
  const top = profile.facts
    .filter((f) => f.status === 'active' || f.status === 'competing')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);

  const factLine = top
    .map((f) => `${f.predicate}=${f.object}`)
    .join('; ');
  const refsLine = Object.keys(profile.externalRefs).length
    ? ` (refs: ${Object.entries(profile.externalRefs)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')})`
    : '';

  switch (style) {
    case 'sales':
      // Sales-tinted phrasing — leads with name + key signal. Still
      // template-rendered (deterministic, no LLM round-trip).
      return `${profile.canonicalName} — ${factLine}.${refsLine}`;
    case 'support':
      return `Customer: ${profile.canonicalName} (${profile.type}). Active state — ${factLine}.${refsLine}`;
    case 'neutral':
    default:
      return `${profile.canonicalName} (${profile.type}): ${factLine}.${refsLine}`;
  }
}

export type SummarizeStyle = 'neutral' | 'sales' | 'support';

export interface SummarizeArgs {
  entityId: string;
  asOf?: string;
  styleHint?: SummarizeStyle;
}

export interface SummarizeResult {
  entityId: string;
  summary: string;
  factsConsidered: number;
  style: SummarizeStyle;
  asOf?: string;
  /**
   * Event-time the summary reflects — the max validFrom across the facts
   * considered (graphiti-style event-time watermark). Lets the caller
   * reason about "as of when", independent of when it was computed.
   */
  asOfValid?: string;
  /** True when this exact (entityId, asOf, style) was served from the LRU. */
  cached: boolean;
}

interface CachedSummary {
  key: string;
  result: Omit<SummarizeResult, 'cached'>;
  /** Wall-clock watermark (max recordedAt) captured at build time. */
  watermark: string | null;
  insertedAt: number;
}
