import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Surreal } from 'surrealdb';
import { ApiKeyService } from '../auth/api-key.service';
import { TenantRegistryService } from '../auth/tenant-registry.service';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { VECTOR_COLUMNS } from '../ai/embedder/embedding-space';
import { ReindexEmbeddingsService } from '../ai/embedder/reindex-embeddings.service';
import { REINDEX_SWEPT_COLUMNS } from '../ai/embedder/reindex-engine.service';
import { JobRunService } from '../jobs/job-run.service';
import { MetricsService } from '../metrics/metrics.service';
import { DistributedLeaseGuard, tenantLeaseKey } from '../common/distributed-lease.guard';
import { InFlightGuard } from '../common/in-flight-guard';

/** One vector column of one tenant, counted by stored width and space. */
export interface VectorColumnCensus {
  table: string;
  field: string;
  /** `reindex` — the reindex sweep re-embeds this column from stored text;
   *  `producer` — the vector is derived by its own pass (summaries,
   *  triggers, admin-supplied centroids) and only that pass can rewrite it. */
  repair: 'reindex' | 'producer';
  /** Rows holding a vector at all. */
  rows: number;
  byWidth: Array<{ width: number; spaceId: string | null; count: number }>;
  conforming: number;
  nonConforming: number;
}

export interface VectorCorpusInventory {
  companyId: string;
  /** The primary space every conforming row must be in. */
  spaceId: string;
  dimension: number;
  columns: VectorColumnCensus[];
  nonConforming: number;
  /** Non-conforming rows the reindex sweep can repair. */
  repairable: number;
  /** Non-conforming rows only their producer can rewrite. */
  producerOwned: number;
}

export interface VectorCorpusRepairResult {
  companyId: string;
  before: VectorCorpusInventory;
  after: VectorCorpusInventory | null;
  /** `repaired` — a sweep ran; `nothing_to_repair`; `embedder_not_ready` —
   *  deferred (the next hook or nightly pass retries); `failed`. */
  outcome: 'repaired' | 'nothing_to_repair' | 'embedder_not_ready' | 'failed';
  error?: string;
}

interface CensusRow {
  count?: number | bigint;
  width?: number | bigint | null;
  spaceId?: string | null;
}

const LOCK_KEY = 'vector-corpus-reconcile';
/** Per-tenant lease of the schema-ready hook's census and repair. */
const STARTUP_LOCK_PREFIX = 'vector_corpus_startup_';
const LEASE_TTL_SECONDS = 30 * 60;
/** One operator-facing line per tenant per hour about a corpus that is still
 *  non-conforming; the metric carries the number continuously. */
const WARN_EVERY_MS = 60 * 60_000;
/** A repair deferred at boot re-checks the embedder every minute, for an hour. */
const DEFERRED_RETRY_EVERY_MS = 60_000;
const DEFERRED_RETRY_MAX_ATTEMPTS = 60;

/**
 * Corpus census and self-repair for the thirteen vector columns.
 *
 * WHY. Every vector column is `option<array<float>>` — the store accepts a
 * vector of any width — and the embedder that serves a deployment is chosen
 * by EMBEDDER_PROVIDER. Change the provider (or boot with the fallback warm
 * while the primary is not) and the corpus and the queries disagree on width.
 * On the read side that used to be a table-wide error per query; the width
 * gate (src/db/vector-width.ts, migration 0138) turned it into "the row is
 * invisible". Invisible is safe, and it is still wrong: the tenant has memory
 * that no dense query can reach. This service is the actuator that makes it
 * right again, and the census that says how far from right it is.
 *
 * HOW. On every tenant's schema-ready hook and once a night, count each
 * column by `array::len(vector)` and `embeddingSpaceId`. Rows whose width is
 * not the primary embedder's are non-conforming. For the columns the reindex
 * sweep owns (knowledge facts, entities, predicates, episodes, segments,
 * scene gists, strategies — REINDEX_SWEPT_COLUMNS) the repair is the sweep
 * itself, run for that tenant, recorded as a `reindex_embeddings` job run so
 * it is visible where every other reindex is. Producer-owned columns
 * (community summaries, procedural triggers, admin-supplied lens centroids,
 * beliefs, fragments) are reported and counted; only their own pass can
 * rewrite them. Nothing here is behind a flag: a corpus the serving model
 * cannot read is a bug, not a configuration.
 *
 * The repair re-embeds from stored text with the PRIMARY embedder, so it is
 * deferred (not skipped) while the primary is still warming — the fallback
 * would only write the wrong width again.
 */
@Injectable()
export class VectorCorpusService implements OnModuleInit {
  private readonly logger = new Logger(VectorCorpusService.name);
  private readonly local = new InFlightGuard();
  private readonly pending = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly warnedAt = new Map<string, number>();
  private draining = false;

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly reindex: ReindexEmbeddingsService,
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly jobs?: JobRunService,
    @Optional() private readonly registry?: TenantRegistryService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  onModuleInit(): void {
    this.surreal.onTenantSchemaReady((companyId) => this.noteTenant(companyId));
  }

  /** A tenant whose schema just became ready gets one census (and repair). */
  noteTenant(companyId: string): void {
    if (this.seen.has(companyId) || this.pending.has(companyId)) return;
    this.pending.add(companyId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const companyId of this.pending) {
        this.pending.delete(companyId);
        this.seen.add(companyId);
        try {
          await this.reconcileAtStartup(companyId);
        } catch (e) {
          this.logger.warn(`vector corpus census failed for ${companyId}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * The hook's census and repair for one tenant, under a per-tenant lease:
   * the schema-ready hook fires on every replica that serves the tenant's
   * first request, and the repair is a full re-embed of that tenant's
   * corpus — N replicas meant N× the embedding spend and concurrent UPDATEs
   * on the same rows. A replica that finds the lease held skips; the holder
   * either repairs, or defers and polls the embedder itself (retryWhenReady),
   * re-entering through the same lease once it is warm. Without a guard
   * (JobsModule not wired) the hook runs bare, as a single process may.
   */
  private async reconcileAtStartup(companyId: string): Promise<void> {
    if (!this.guard) {
      await this.reconcileTenant(companyId, 'startup');
      return;
    }
    const run = await this.guard.run(
      tenantLeaseKey(STARTUP_LOCK_PREFIX, companyId),
      () => this.reconcileTenant(companyId, 'startup'),
      LEASE_TTL_SECONDS,
    );
    if (run === null) {
      this.logger.log(
        `vector corpus census for ${companyId} skipped — another replica holds the lease`,
      );
    }
  }

  /** 05:40 UTC — after the HNSW provisioning sweep (05:10). */
  @Cron('40 5 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<VectorCorpusRepairResult[]> {
    const run = this.guard
      ? await this.guard.run(LOCK_KEY, () => this.reconcileAll('cron'), LEASE_TTL_SECONDS)
      : await this.local.run(LOCK_KEY, () => this.reconcileAll('cron'));
    if (run === null) {
      this.logger.warn('vector corpus reconcile skipped — a previous run is still in flight');
      return [];
    }
    return run;
  }

  async reconcileAll(trigger: 'cron' | 'manual' = 'manual'): Promise<VectorCorpusRepairResult[]> {
    const results: VectorCorpusRepairResult[] = [];
    const totals = new Map<string, number>();
    let tenantsNonConforming = 0;
    for (const companyId of this.roster()) {
      try {
        const r = await this.reconcileTenant(companyId, trigger);
        results.push(r);
        const final = r.after ?? r.before;
        if (final.nonConforming > 0) tenantsNonConforming++;
        for (const c of final.columns) {
          const key = `${c.table}.${c.field}`;
          totals.set(key, (totals.get(key) ?? 0) + c.nonConforming);
        }
      } catch (e) {
        this.logger.warn(
          `vector corpus reconcile failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    if (this.metrics) {
      for (const col of VECTOR_COLUMNS) {
        this.metrics.setVectorCorpusNonconforming(
          col.table,
          col.field,
          totals.get(`${col.table}.${col.field}`) ?? 0,
        );
      }
      this.metrics.setVectorCorpusTenantsNonconforming(tenantsNonConforming);
    }
    return results;
  }

  /**
   * Census, then repair what the sweep can repair. The census runs on the
   * root pool: it reads counts, never rows, and is the operator's view.
   */
  async reconcileTenant(
    companyId: string,
    trigger: 'startup' | 'cron' | 'manual',
  ): Promise<VectorCorpusRepairResult> {
    const before = await this.inventory(companyId);
    if (before.nonConforming === 0) {
      return { companyId, before, after: null, outcome: 'nothing_to_repair' };
    }
    this.warnOnce(companyId, before);
    if (before.repairable === 0) {
      return { companyId, before, after: null, outcome: 'nothing_to_repair' };
    }
    if (!this.embedder.isReady()) {
      // The schema-ready hook fires during boot, before the primary embedder
      // has finished warming (bge-m3: ~30 s in-thread), so a boot-time census
      // almost always lands here. Waiting for the nightly pass would leave the
      // tenant's dense retrieval blind for a day; instead the tenant is
      // re-queued once the embedder reports ready, polling every minute for
      // up to an hour (a warmup that never completes is #518's problem and
      // is visible on /ready).
      this.logger.warn(
        `vector corpus repair for ${companyId} deferred: ${before.repairable} row(s) need the ` +
          `primary embedder (${before.spaceId}) and it is not ready yet; ` +
          `retried as soon as it is`,
      );
      this.metrics?.countVectorCorpusRepair('deferred');
      if (trigger === 'startup') this.retryWhenReady(companyId);
      return { companyId, before, after: null, outcome: 'embedder_not_ready' };
    }
    const run = await this.jobs?.start({
      jobType: 'reindex_embeddings',
      companyId,
      triggeredBy: trigger === 'manual' ? 'manual' : trigger,
      initialProgress: {
        reason: 'vector_corpus_repair',
        tenantFilter: companyId,
        nonConforming: before.nonConforming,
        repairable: before.repairable,
      },
    });
    try {
      const sweep = await this.reindex.run({ tenant: companyId, allTables: true });
      const after = await this.inventory(companyId);
      await this.jobs?.finish(run!, {
        status: 'succeeded',
        result: {
          factsScanned: sweep.factsScanned,
          factsUpdated: sweep.factsUpdated,
          tables: sweep.tables ?? [],
          nonConformingBefore: before.nonConforming,
          nonConformingAfter: after.nonConforming,
        },
      });
      this.metrics?.countVectorCorpusRepair(after.repairable === 0 ? 'repaired' : 'partial');
      this.logger.log(
        `vector corpus repair for ${companyId}: ${before.repairable} non-conforming row(s) ` +
          `re-embedded into ${before.spaceId}; ${after.nonConforming} remain` +
          `${after.producerOwned > 0 ? ` (${after.producerOwned} producer-owned)` : ''}`,
      );
      return { companyId, before, after, outcome: 'repaired' };
    } catch (e) {
      const message = (e as Error).message;
      await this.jobs?.finish(run!, {
        status: 'failed',
        error: { message, name: (e as Error).name },
      });
      this.metrics?.countVectorCorpusRepair('failed');
      this.logger.error(`vector corpus repair for ${companyId} failed: ${message}`);
      return { companyId, before, after: null, outcome: 'failed', error: message };
    }
  }

  /** Poll the embedder's readiness and re-queue the tenant the moment it is warm. */
  private retryWhenReady(companyId: string, attempt = 0): void {
    if (attempt >= DEFERRED_RETRY_MAX_ATTEMPTS) {
      this.logger.warn(
        `vector corpus repair for ${companyId} still deferred after ` +
          `${DEFERRED_RETRY_MAX_ATTEMPTS} checks — the nightly pass will retry`,
      );
      return;
    }
    const timer = setTimeout(() => {
      if (this.embedder.isReady()) {
        this.seen.delete(companyId);
        this.noteTenant(companyId);
      } else {
        this.retryWhenReady(companyId, attempt + 1);
      }
    }, DEFERRED_RETRY_EVERY_MS);
    // Never keep the process alive for it.
    timer.unref?.();
  }

  /** Read-only census of every vector column. */
  async inventory(companyId: string): Promise<VectorCorpusInventory> {
    const dimension = this.embedder.primaryDimensions();
    const spaceId = this.embedder.primarySpaceId();
    const columns = await this.surreal.withCompany(companyId, async (db) => {
      const out: VectorColumnCensus[] = [];
      for (const col of VECTOR_COLUMNS) {
        out.push(await this.censusColumn(db, col, dimension));
      }
      return out;
    });
    const nonConforming = columns.reduce((n, c) => n + c.nonConforming, 0);
    const repairable = columns
      .filter((c) => c.repair === 'reindex')
      .reduce((n, c) => n + c.nonConforming, 0);
    return {
      companyId,
      spaceId,
      dimension,
      columns,
      nonConforming,
      repairable,
      producerOwned: nonConforming - repairable,
    };
  }

  private async censusColumn(
    db: Surreal,
    col: { table: string; field: string },
    dimension: number,
  ): Promise<VectorColumnCensus> {
    const { table, field } = col;
    // `table`/`field` come from VECTOR_COLUMNS, never from a caller.
    // embeddingSpaceId is NONE on tables that never got the column (0101
    // added it to the swept tables, 0132 to lens_suppression) — the width is
    // what decides conformance; the space id is reported for the operator.
    const [rows] = await db.query<[CensusRow[]]>(
      `SELECT count() AS count, array::len(${field}) AS width, embeddingSpaceId AS spaceId
         FROM ${table}
        WHERE ${field} != NONE
        GROUP BY width, spaceId`,
    );
    const byWidth = ((rows as CensusRow[]) ?? [])
      .map((r) => ({
        width: Number(r.width ?? 0),
        spaceId: typeof r.spaceId === 'string' ? r.spaceId : null,
        count: Number(r.count ?? 0),
      }))
      .sort((a, b) => a.width - b.width || (a.spaceId ?? '').localeCompare(b.spaceId ?? ''));
    const total = byWidth.reduce((n, r) => n + r.count, 0);
    const conforming = byWidth
      .filter((r) => r.width === dimension)
      .reduce((n, r) => n + r.count, 0);
    const repair = REINDEX_SWEPT_COLUMNS.some((c) => c.table === table && c.field === field)
      ? 'reindex'
      : 'producer';
    return {
      table,
      field,
      repair,
      rows: total,
      byWidth,
      conforming,
      nonConforming: total - conforming,
    };
  }

  private warnOnce(companyId: string, inv: VectorCorpusInventory): void {
    const last = this.warnedAt.get(companyId) ?? 0;
    if (Date.now() - last < WARN_EVERY_MS) return;
    this.warnedAt.set(companyId, Date.now());
    const detail = inv.columns
      .filter((c) => c.nonConforming > 0)
      .map(
        (c) =>
          `${c.table}.${c.field}=${c.nonConforming}` +
          `[${c.byWidth
            .filter((w) => w.width !== inv.dimension)
            .map((w) => `${w.width}${w.spaceId ? `@${w.spaceId}` : ''}×${w.count}`)
            .join(',')}]`,
      )
      .join(' ');
    this.logger.warn(
      `vector corpus for ${companyId} has ${inv.nonConforming} row(s) not in the primary space ` +
        `${inv.spaceId} (${inv.dimension}-wide): ${detail}. They are invisible to dense retrieval ` +
        `until re-embedded; ${inv.repairable} repairable by the reindex sweep, ` +
        `${inv.producerOwned} producer-owned.`,
    );
  }

  private roster(): readonly string[] {
    const active = this.registry?.activeCompanyIds() ?? [];
    return active.length > 0 ? active : this.apiKeys.knownCompanyIds();
  }
}
