import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ApiKeyService } from '../../auth/api-key.service';
import { ReindexEngineService, type TableReindexCount } from './reindex-engine.service';
import {
  errorMessage,
  failedBatchOutcome,
  foldNestedOutcomes,
  type BatchOutcome,
} from '../../common/batch-outcome';

export interface ReindexResult {
  tenantsScanned: number;
  factsScanned: number;
  factsUpdated: number;
  durationMs: number;
  dryRun: boolean;
  provider: string;
  /** Per-table breakdown, present ONLY when the opt-in all-tables sweep
   *  ran; absent on the default knowledge_fact-only path. */
  tables?: TableReindexCount[];
  /**
   * Roster fold: units are tenants (`failed[].key` is a companyId); a
   * tenant whose sweep degraded (a table failed) degrades the whole.
   */
  outcome: BatchOutcome;
}

export interface ReindexOptions {
  /** Limit to a single tenant; default = every known tenant. */
  tenant?: string;
  /** When true, count rows that would be updated but write nothing. */
  dryRun?: boolean;
  /** Cap on facts processed per tenant; protects against runaway batches. */
  maxFacts?: number;
  /**
   * Opt-in: also sweep the non-fact embedding tables (entity, predicate,
   * episode, segment, strategy_memory). Default (undefined/false) = the
   * historical knowledge_fact-only reindex, byte-identical.
   */
  allTables?: boolean;
  /** Retry selector: sweep exactly these tables (REINDEX_SWEPT_COLUMNS). */
  tables?: string[];
  /**
   * Repair selector: rewrite ONLY rows whose vector is present and not `dim`
   * wide. The corpus census (VectorCorpusService) passes its primary
   * dimension here so one stray row costs one embed, not a full-tenant
   * re-embed.
   */
  widthMismatchOnly?: { dim: number };
}

/**
 * Phase 4.D.2 — re-embed existing knowledge_fact rows with the active
 * embedder provider. Used by operators after flipping
 * `EMBEDDER_PROVIDER=bge-m3` so historical facts (still carrying the
 * OpenAI text-embedding-3-small vector) move into the new vector
 * space and become reachable by cross-lingual queries.
 *
 * Safety:
 *   - tenant-aware: one tenant's failure logs and continues
 *   - paginated: SELECT ... LIMIT N OFFSET ... so memory stays flat
 *   - dryRun: counts rows without writing — operators sanity-check
 *     batch size before committing
 *   - idempotent: an already-correct row is rewritten with the same
 *     vector, no semantic change
 *
 * NOT scheduled. Triggered only via the admin endpoint so an operator
 * sees the impact in real time.
 */
@Injectable()
export class ReindexEmbeddingsService {
  private readonly logger = new Logger(ReindexEmbeddingsService.name);

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly engine: ReindexEngineService,
  ) {}

  async run(opts: ReindexOptions = {}): Promise<ReindexResult> {
    const started = Date.now();
    const dryRun = opts.dryRun === true;
    const maxFacts = opts.maxFacts ?? Number.MAX_SAFE_INTEGER;
    const tenants = opts.tenant ? [opts.tenant] : this.apiKeys.knownCompanyIds();

    const allTables = opts.allTables === true;
    const breakdown = allTables || opts.tables !== undefined;
    let factsScanned = 0;
    let factsUpdated = 0;
    // Aggregate the per-table sweep counts across tenants (all-tables only).
    const tableTotals = new Map<string, TableReindexCount>();
    const parts: Array<{ key: string; outcome: BatchOutcome }> = [];
    for (const companyId of tenants) {
      try {
        const tenantResult = await this.engine.reindexTenant(companyId, {
          dryRun,
          remaining: maxFacts - factsScanned,
          allTables,
          ...(opts.tables !== undefined ? { tables: opts.tables } : {}),
          ...(opts.widthMismatchOnly !== undefined
            ? { widthMismatchOnly: opts.widthMismatchOnly }
            : {}),
        });
        parts.push({ key: companyId, outcome: tenantResult.outcome });
        factsScanned += tenantResult.factsScanned;
        factsUpdated += tenantResult.factsUpdated;
        for (const t of tenantResult.tables ?? []) {
          const acc = tableTotals.get(t.table) ?? { table: t.table, scanned: 0, updated: 0 };
          acc.scanned += t.scanned;
          acc.updated += t.updated;
          tableTotals.set(t.table, acc);
        }
        if (factsScanned >= maxFacts) break;
      } catch (e) {
        // The engine propagates warmup/write-guard failures. Preserve that
        // signal through the tenant loop so HTTP and queued jobs see failure,
        // rather than a successful run that rewrote zero vectors.
        if (e instanceof ServiceUnavailableException) throw e;
        parts.push({ key: companyId, outcome: failedBatchOutcome(errorMessage(e)) });
        this.logger.warn(`reindex failed for ${companyId}: ${errorMessage(e)}`);
      }
    }

    const result: ReindexResult = {
      tenantsScanned: tenants.length,
      factsScanned,
      factsUpdated,
      durationMs: Date.now() - started,
      dryRun,
      provider: this.engine.providerId(),
      ...(breakdown ? { tables: [...tableTotals.values()] } : {}),
      outcome: foldNestedOutcomes(parts),
    };
    this.logger.log(
      `reindex done — provider=${result.provider} tenants=${result.tenantsScanned} scanned=${result.factsScanned} updated=${result.factsUpdated} dryRun=${dryRun}`,
    );
    return result;
  }
}
