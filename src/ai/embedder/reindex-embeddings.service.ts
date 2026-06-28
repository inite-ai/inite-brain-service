import { Injectable, Logger } from '@nestjs/common';
import { ApiKeyService } from '../../auth/api-key.service';
import { ReindexEngineService } from './reindex-engine.service';

export interface ReindexResult {
  tenantsScanned: number;
  factsScanned: number;
  factsUpdated: number;
  durationMs: number;
  dryRun: boolean;
  provider: string;
}

export interface ReindexOptions {
  /** Limit to a single tenant; default = every known tenant. */
  tenant?: string;
  /** When true, count rows that would be updated but write nothing. */
  dryRun?: boolean;
  /** Cap on facts processed per tenant; protects against runaway batches. */
  maxFacts?: number;
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
    const tenants = opts.tenant
      ? [opts.tenant]
      : this.apiKeys.knownCompanyIds();

    let factsScanned = 0;
    let factsUpdated = 0;
    for (const companyId of tenants) {
      try {
        const tenantResult = await this.engine.reindexTenant(companyId, {
          dryRun,
          remaining: maxFacts - factsScanned,
        });
        factsScanned += tenantResult.factsScanned;
        factsUpdated += tenantResult.factsUpdated;
        if (factsScanned >= maxFacts) break;
      } catch (e) {
        this.logger.warn(
          `reindex failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }

    const result: ReindexResult = {
      tenantsScanned: tenants.length,
      factsScanned,
      factsUpdated,
      durationMs: Date.now() - started,
      dryRun,
      provider: this.engine.providerId(),
    };
    this.logger.log(
      `reindex done — provider=${result.provider} tenants=${result.tenantsScanned} scanned=${result.factsScanned} updated=${result.factsUpdated} dryRun=${dryRun}`,
    );
    return result;
  }
}
