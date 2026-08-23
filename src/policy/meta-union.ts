import { Logger } from '@nestjs/common';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled } from '../common/env-validation';
import { policyFor } from '../ingest/conflict-resolver';
import { SurrealService, queryRows } from '../db/surreal.service';
import { evaluateRow, toRowView } from './policy-engine';
import { PolicyContext, PolicyRowView } from './policy.types';

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

/** Raw source_document projection for the origin-meta batch lookup. */
interface SourceDocMetaRow {
  contentHash: unknown;
  meta?: unknown;
}

export interface MetaUnionRow {
  predicate: string;
  source?: unknown;
  trustSnapshot?: PolicyRowView['trustSnapshot'];
  corroboration?: ({ originKeys?: string[] } & { count?: number }) | null;
  userId?: string | null;
}

/**
 * Cache key MUST be tenant-scoped: `contentHash` is unique only within a
 * tenant DB (the UNIQUE index is per-tenant), so two tenants can share a
 * hash. Keying the process-wide LRU by the bare `doc:<hash>` origin key
 * would serve tenant A's document meta to tenant B — a cross-tenant leak
 * on the exact deny surface this module enforces. NUL separates the
 * companyId from the origin key (neither ever emits it).
 */
function cacheKey(companyId: string, originKey: string): string {
  return `${companyId}\u0000${originKey}`;
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
      if (key.startsWith('doc:') && !isFresh(metaCache.get(cacheKey(companyId, key)))) {
        wanted.add(key);
      }
    }
  }

  if (wanted.size > 0) {
    try {
      const hashes = [...wanted].map((k) => k.slice('doc:'.length));
      const found = await surreal.withCompany(companyId, (db) =>
        queryRows<SourceDocMetaRow>(
          db,
          `SELECT contentHash, meta FROM source_document
            WHERE contentHash INSIDE $hashes`,
          { hashes },
        ),
      );
      const at = Date.now();
      for (const doc of found) {
        metaCache.set(cacheKey(companyId, `doc:${String(doc.contentHash)}`), {
          meta:
            doc.meta && typeof doc.meta === 'object'
              ? (doc.meta as Record<string, unknown>)
              : null,
          at,
        });
      }
      // Negative-cache misses so unknown origins don't refetch per request.
      for (const key of wanted) {
        const ck = cacheKey(companyId, key);
        if (!metaCache.has(ck)) metaCache.set(ck, { meta: null, at });
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
      const cached = key.startsWith('doc:')
        ? metaCache.get(cacheKey(companyId, key))
        : undefined;
      const meta = cached?.meta;
      if (!meta) continue;
      const src = (row.source ?? {}) as Record<string, unknown>;
      // Carry the row's own trust/corroboration/userId into the view so a
      // COMPOUND deny rule (source.meta.* AND trustSnapshot.* / userId) still
      // fires on the unioned meta — evaluating meta in isolation would let
      // such a rule silently pass.
      const view = toRowView(
        {
          predicate: row.predicate,
          source: { ...src, meta },
          trustSnapshot: row.trustSnapshot,
          corroboration: row.corroboration,
          userId: row.userId,
        },
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
