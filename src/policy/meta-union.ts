import { Logger } from '@nestjs/common';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled } from '../common/env-validation';
import { policyFor } from '../ingest/conflict-resolver';
import { SurrealService } from '../db/surreal.service';
import { evaluateRow, toRowView } from './policy-engine';
import { PolicyContext } from './policy.types';

/**
 * Effective-metadata union across corroborating origins
 * (POLICY_META_UNION_ENABLED, default off).
 *
 * A fact corroborated by several documents carries only the ORIGIN
 * KEYS of its confirmers (corroboration.originKeys, migration 0050) —
 * not their metadata. Without this pass, a support-classed fact that
 * was independently confirmed by an hr-classed document slips past a
 * `source.meta.data_class` deny rule because only the incumbent's own
 * meta is on the row. Zep's "effective metadata is the union across
 * episodes" closes exactly this hole; this module is our equivalent:
 * DENY if ANY contributing origin's document meta matches a deny rule
 * (union = most restrictive).
 *
 * Cost model: doc-shaped origin keys are `doc:<contentHash>` — resolved
 * through the UNIQUE contentHash index in one batched query per
 * request, behind a process LRU (10k entries, 5 min TTL). Non-document
 * origins (vertical:recorder) carry no metadata and are skipped.
 * Applied on the primary retrieval surfaces (search fusion,
 * graph_retrieve); supplementary legs (edge expansion, backfill)
 * evaluate only the row's own meta — documented approximation while
 * the flag matures.
 */

const logger = new Logger('PolicyMetaUnion');

const CACHE_TTL_MS = 5 * 60 * 1000;
const metaCache = new LRUCache<
  string,
  { meta: Record<string, unknown> | null; at: number }
>(10_000);

export interface MetaUnionRow {
  predicate: string;
  source?: unknown;
  corroboration?: { originKeys?: string[] } | null;
}

export function metaUnionEnabled(): boolean {
  return envFlagEnabled(process.env.POLICY_META_UNION_ENABLED);
}

/** Does any enforce/report set carry a deny rule touching source.meta.*? */
export function contextHasMetaDenyRules(ctx: PolicyContext): boolean {
  return ctx.sets.some((set) =>
    set.sourceDeny.some((rule) =>
      rule.conditions.some((c) => c.attr.startsWith('source.meta.')),
    ),
  );
}

/**
 * Drop rows whose corroborating origins' metadata trips a deny rule.
 * Returns the surviving subset; soft-fails open to the un-unioned
 * verdicts on lookup errors (the row's own meta was already enforced).
 */
export async function applyMetaUnion<T extends MetaUnionRow>(opts: {
  surreal: SurrealService;
  companyId: string;
  ctx: PolicyContext;
  rows: T[];
}): Promise<T[]> {
  const { surreal, companyId, ctx, rows } = opts;
  if (!metaUnionEnabled() || !contextHasMetaDenyRules(ctx)) return rows;

  const wanted = new Set<string>();
  for (const row of rows) {
    for (const key of row.corroboration?.originKeys ?? []) {
      if (key.startsWith('doc:') && !isFresh(metaCache.get(key))) {
        wanted.add(key);
      }
    }
  }

  if (wanted.size > 0) {
    try {
      const hashes = [...wanted].map((k) => k.slice('doc:'.length));
      const found = await surreal.withCompany(companyId, async (db) => {
        const [r] = await db.query<[any[]]>(
          `SELECT contentHash, meta FROM source_document
            WHERE contentHash INSIDE $hashes`,
          { hashes },
        );
        return (r as any[]) ?? [];
      });
      const at = Date.now();
      for (const doc of found) {
        metaCache.set(`doc:${String(doc.contentHash)}`, {
          meta:
            doc.meta && typeof doc.meta === 'object'
              ? (doc.meta as Record<string, unknown>)
              : null,
          at,
        });
      }
      // Negative-cache misses so unknown origins don't refetch per request.
      for (const key of wanted) {
        if (!metaCache.has(key)) metaCache.set(key, { meta: null, at });
      }
    } catch (e) {
      logger.warn(
        `origin-meta lookup failed, meta-union skipped this request: ${(e as Error).message}`,
      );
      return rows;
    }
  }

  return rows.filter((row) => {
    const origins = row.corroboration?.originKeys ?? [];
    for (const key of origins) {
      const cached = key.startsWith('doc:') ? metaCache.get(key) : undefined;
      const meta = cached?.meta;
      if (!meta) continue;
      const src = (row.source ?? {}) as Record<string, unknown>;
      const view = toRowView(
        { predicate: row.predicate, source: { ...src, meta } },
        (p) => policyFor(p).piiClass,
      );
      if (evaluateRow(ctx, view).decision === 'deny') return false;
    }
    return true;
  });
}

function isFresh(
  entry: { meta: Record<string, unknown> | null; at: number } | undefined,
): boolean {
  return entry !== undefined && Date.now() - entry.at < CACHE_TTL_MS;
}
