import type { Logger } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';

/**
 * The shared skeleton of the write-time insight composers (aggregates,
 * arcs). Extracted in the V9 quality pass — the arc composer began as
 * an ~80% structural copy of the aggregate composer, and a third
 * composer would have made it three copies of the same swap
 * discipline. The kernel owns everything that MUST stay identical
 * across composers because it encodes invariants:
 *
 *   - entity selection: top-N fact-densest entities of the version's
 *     namespace, derived state excluded from the count;
 *   - per-entity error accounting (one entity's failure never fails
 *     the run — it lands in `skipped` with its reason);
 *   - paid-work-before-swap: the LLM proposal and the embeddings are
 *     computed BEFORE any delete, so a failure leaves the previous
 *     derived set intact;
 *   - the atomic swap: delete-by-recorder + insert share ONE
 *     transaction, so a retrieval landing mid-rerun sees the previous
 *     set or the new one, never an entity stripped of its rows.
 *
 * What stays in each composer is exactly its identity: the LLM
 * proposal call, per-proposal validity, and the row it writes.
 */

export interface FactRowLite {
  id: unknown;
  predicate: string;
  object: string;
  validFrom?: string | Date;
}

/**
 * Day stamp of a fact's validFrom for prompts and validity gates. The
 * SDK decodes datetime columns to JS Dates (CBOR), whose String() form
 * ("Sat Aug 09 2026 …") would lose the year to a 10-char slice and
 * break distinct-day comparisons — normalize to ISO first.
 */
export function factDay(value?: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
}

export interface InsightComposerSpec<P> {
  /** Row owner — the delete-by-recorder swap key. */
  recorder: string;
  /**
   * WHERE fragment excluding derived state from the SOURCE pool
   * (appended verbatim to both the entity-selection and the per-entity
   * facts query), with its bound params. Must at minimum exclude the
   * composer's own recorder.
   */
  sourceExclusionSql: string;
  sourceExclusionParams: Record<string, unknown>;
  /** Entities with fewer source facts are skipped without an LLM call. */
  minFacts: number;
  /** The paid proposal call — one per composed entity. */
  propose(name: string, factLines: string[]): Promise<P[]>;
  /** Per-proposal validity gate (member indexes, date spread, …). */
  valid(proposal: P, facts: FactRowLite[]): boolean;
  /** Text embedded for the row (already capped by the composer). */
  embeddingTextOf(proposal: P): string;
  /** The knowledge_fact row for one valid proposal. */
  buildRow(
    proposal: P,
    ctx: {
      entityId: StringRecordId;
      facts: FactRowLite[];
      vector: number[];
      version?: string | undefined;
    },
  ): Record<string, unknown>;
}

export interface ComposerRunResult {
  entities: number;
  written: number;
  skipped: Array<{ entityId: string; reason: string }>;
}

interface KernelDeps {
  surreal: SurrealService;
  embedding: FactEmbeddingService;
  logger: Logger;
}

type QueryDb = {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
};

/**
 * Run one composer over the top-`entities` fact-densest entities of
 * the given derived namespace. With `version` set, sources come from
 * that namespace and rows are stamped with the same `derivedVersion` —
 * REQUIRED for a RETRIEVAL_DERIVED_VERSION-pinned world to see them.
 */
export async function runInsightComposer<P>(
  deps: KernelDeps,
  spec: InsightComposerSpec<P>,
  opts: {
    companyId: string;
    entities?: number | undefined;
    version?: string | undefined;
  },
): Promise<ComposerRunResult> {
  const { companyId } = opts;
  const entityCap = Math.min(Math.max(opts.entities ?? 12, 1), 50);
  const version = opts.version?.trim() || undefined;
  const versionClause = version
    ? 'AND derivedVersion = $version'
    : 'AND derivedVersion IS NONE';
  const result: ComposerRunResult = { entities: 0, written: 0, skipped: [] };
  await deps.surreal.withCompany(companyId, async (db) => {
    const [tops] = await db.query<[Array<{ entityId: unknown; n: number }>]>(
      `SELECT entityId, count() AS n FROM knowledge_fact
        WHERE status = 'active'
          ${spec.sourceExclusionSql}
          ${versionClause}
        GROUP BY entityId ORDER BY n DESC LIMIT $k`,
      { k: entityCap, version, ...spec.sourceExclusionParams },
    );
    for (const top of tops ?? []) {
      const entityId = String(top.entityId);
      try {
        const written = await composeEntity(deps, db, {
          spec,
          entityId,
          version,
          versionClause,
        });
        result.entities += 1;
        result.written += written;
      } catch (e) {
        result.skipped.push({ entityId, reason: (e as Error).message });
        deps.logger.warn(
          `${spec.recorder} compose failed for ${entityId}: ${(e as Error).message}`,
        );
      }
    }
  });
  return result;
}

async function composeEntity<P>(
  deps: KernelDeps,
  db: QueryDb,
  ctx: {
    spec: InsightComposerSpec<P>;
    entityId: string;
    version?: string | undefined;
    versionClause: string;
  },
): Promise<number> {
  const { spec, entityId, version, versionClause } = ctx;
  const [[entity]] = await db.query<[Array<{ canonicalName?: string }>]>(
    `SELECT canonicalName FROM $eid`,
    { eid: new StringRecordId(entityId) },
  );
  const name = entity?.canonicalName ?? entityId;
  const [facts] = await db.query<[FactRowLite[]]>(
    `SELECT id, predicate, object, validFrom FROM knowledge_fact
      WHERE entityId = $eid AND status = 'active'
        ${spec.sourceExclusionSql}
        ${versionClause}
      ORDER BY validFrom ASC LIMIT 400`,
    {
      eid: new StringRecordId(entityId),
      version,
      ...spec.sourceExclusionParams,
    },
  );
  if (!facts || facts.length < spec.minFacts) return 0;

  const lines = facts.map(
    (f, i) => `${i}. ${f.predicate}: ${f.object} (${factDay(f.validFrom)})`,
  );
  const proposals = await spec.propose(name, lines);
  const valid = proposals.filter((p) => spec.valid(p, facts));
  // Every paid step (the proposal above, embeddings here) runs BEFORE
  // the delete — a failure leaves the previous derived set intact.
  const vectors =
    valid.length > 0
      ? await deps.embedding.embedMany(valid.map((p) => spec.embeddingTextOf(p)))
      : [];
  const rows = valid.map((p, i) =>
    spec.buildRow(p, {
      entityId: new StringRecordId(entityId),
      facts,
      vector: vectors[i]!, // vectors is 1:1 with valid (embedMany) ⇒ in-bounds
      version,
    }),
  );
  // Wholesale replace: composed rows are derived state, a re-run owns
  // them. Atomic swap (audit W2 #10/#11): the delete and the insert
  // share one transaction.
  await runTransaction(db as unknown as Surreal, (tx) => {
    tx.add(
      `DELETE knowledge_fact
        WHERE entityId = $eid AND source.recorder = $recorder
          ${versionClause}`,
    );
    if (rows.length > 0) tx.add(`INSERT INTO knowledge_fact $rows`);
    tx.bind('eid', new StringRecordId(entityId))
      .bind('recorder', spec.recorder)
      .bind('version', version)
      .bind('rows', rows);
  });
  return valid.length;
}
