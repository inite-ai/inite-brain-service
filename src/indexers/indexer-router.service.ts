import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { BUILTIN_PACKS } from '../ai/domain-packs';
import type { DomainPackManifest } from '../ai/domain-packs/manifest';
import { traceArtifact } from '../common/debug-trace';
import {
  cosineSimilarity,
  DEFAULT_RELEVANCE_THRESHOLD,
  IndexerBinding,
  ROUTER_HEAD_CHARS,
  routeByRules,
  RoutingInput,
} from './routing';

/**
 * Which indexers read a given document. Bindings come from the tenant's
 * packs (builtin + installed); routing is layered by cost:
 *
 *   L0  explicit request / vertical subscription / alwaysRun   (free)
 *   L1  keyword triggers over the document head                (free)
 *   L2  cosine(document head, pack relevance.description)      (embeds,
 *       both sides LRU-cached by the embedder)
 *
 * A dedicated pack with NO relevance triggers only runs when explicitly
 * requested — the pack author opted into cost, the router refuses to
 * guess. An L3 mini-LLM classifier is deliberately absent until a tenant
 * profile needs it.
 */
@Injectable()
export class IndexerRouterService {
  private readonly logger = new Logger(IndexerRouterService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  /** All indexer bindings for a tenant: builtin + active installed packs. */
  async bindingsFor(companyId: string): Promise<IndexerBinding[]> {
    const manifests = [...BUILTIN_PACKS, ...(await this.installedManifests(companyId))];
    const seen = new Set<string>();
    const bindings: IndexerBinding[] = [];
    for (const m of manifests) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      bindings.push({
        indexerId: m.id,
        packVersion: m.version,
        mode: m.indexer?.mode ?? 'virtual',
        description: m.description,
        relevance: m.indexer?.relevance,
        dedicated: m.indexer?.dedicated,
      });
    }
    return bindings;
  }

  /** Dedicated bindings that should read this document. */
  async route(
    companyId: string,
    input: RoutingInput,
  ): Promise<IndexerBinding[]> {
    const bindings = await this.bindingsFor(companyId);
    const { selected, needEmbedding } = routeByRules(bindings, input);
    const viaEmbedding = await this.routeByEmbedding(needEmbedding, input);
    const all = [...selected, ...viaEmbedding];
    traceArtifact('indexer.route', {
      vertical: input.vertical,
      requested: input.requested,
      selected: all.map((b) => b.indexerId),
      viaEmbedding: viaEmbedding.map((b) => b.indexerId),
    });
    return all;
  }

  private async routeByEmbedding(
    candidates: IndexerBinding[],
    input: RoutingInput,
  ): Promise<IndexerBinding[]> {
    if (candidates.length === 0) return [];
    let headVec: number[];
    try {
      headVec = await this.embedder.embed(input.head.slice(0, ROUTER_HEAD_CHARS));
    } catch (e) {
      this.logger.warn(`router L2 head embed failed: ${(e as Error).message}`);
      return [];
    }
    const out: IndexerBinding[] = [];
    for (const b of candidates) {
      try {
        // Pack descriptions are stable strings — the embedder's LRU makes
        // this a one-time cost per pack per process.
        const descVec = await this.embedder.embed(b.relevance!.description!);
        const sim = cosineSimilarity(headVec, descVec);
        if (sim >= (b.relevance?.threshold ?? DEFAULT_RELEVANCE_THRESHOLD)) {
          out.push(b);
        }
      } catch (e) {
        this.logger.warn(
          `router L2 embed failed for pack ${b.indexerId}: ${(e as Error).message}`,
        );
      }
    }
    return out;
  }

  private async installedManifests(
    companyId: string,
  ): Promise<DomainPackManifest[]> {
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const [rows] = await db.query<[any[]]>(
          `SELECT manifest FROM domain_pack WHERE status = 'active'`,
        );
        return (((rows as any[]) ?? []) as Array<{ manifest: DomainPackManifest }>)
          .map((r) => r.manifest)
          .filter(Boolean);
      });
    } catch (e) {
      this.logger.warn(
        `router: reading installed packs failed for ${companyId}: ${(e as Error).message}`,
      );
      return [];
    }
  }
}
