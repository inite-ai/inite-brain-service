import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { ReadPinService } from '../episodes/read-pin.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { makeRowPolicyFilter } from '../policy/row-filter';
import { fuse } from '../search/internals/fusion';
import {
  INSIGHT_TOP_K,
  runInsightLegs,
} from '../search/internals/insight-leg';

/**
 * Insight lane (V8 §1) — the prompt-side consumer of the insight
 * fusion leg. Runs ONLY when the resolved profile says
 * insightEvidence='routed' AND the question routed to a class that
 * pays for derived insights (summary / enumeration lanes — the caller
 * gates; this service is class-agnostic).
 *
 * Same contracts as the sibling lanes (episode / segment): PII fence
 * via callerScopes, fail-closed user scope, degrade to [] on any
 * failure, no env reads — activation comes from the resolved
 * RetrievalProfile via the caller. The derived-world pin is resolved
 * per tenant exactly like search.service does (registry first, env
 * bootstrap fallback), so the lane reads the same world the fact legs
 * read.
 */
@Injectable()
export class InsightLaneService {
  private readonly logger = new Logger(InsightLaneService.name);

  // Registry dep landed with the audit's row-policy fix — same
  // @Optional degradation contract as the read pin.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    @Optional() private readonly readPin?: ReadPinService,
    @Optional() private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  async insightLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string | undefined;
  }): Promise<string[]> {
    const fetchK = Math.max(INSIGHT_TOP_K * 3, 12);
    try {
      const derivedVersion =
        (await this.readPin?.resolveRead(opts.companyId)) ??
        ReadPinService.bootstrapRead();
      const queryVector = await this.embedder.embed(opts.query);
      const fused = await this.surreal.withCompany(
        opts.companyId,
        async (db) => {
          const { vectorRows, lexicalRows } = await runInsightLegs({
            db,
            queryText: opts.query,
            queryVector,
            fetchK,
            callerScopes: opts.callerScopes,
            ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
            derivedVersion,
          });
          return fuse(vectorRows, lexicalRows, 'hybrid');
        },
      );
      // Audit 2026-08-19 P1: the same predicate scope-fence + ABAC row
      // verdict every other prompt-producing lane applies (the SQL
      // gates cover pii/user; operator-set requiresScope lives only in
      // the registry).
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: opts.callerScopes,
        surface: 'insight_lane',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(
          opts.companyId,
        ),
      });
      const admitted = fused.filter((r) => rowPolicy.filter(r));
      rowPolicy.finish();
      return admitted
        .sort((a, b) => b.fusedScore - a.fusedScore)
        .slice(0, INSIGHT_TOP_K)
        .map((r) => {
          const day = String(r.validFrom ?? '').slice(0, 10);
          return `- ${r.object}${day ? ` (as of ${day})` : ''}`;
        });
    } catch (e) {
      this.logger.warn(
        `insight lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }
}
