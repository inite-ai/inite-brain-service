import { Injectable, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
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
  RoutedMode,
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
        external: m.indexer?.external,
      });
    }
    return bindings;
  }

  /** Bindings of one routed mode that should read this document. */
  async route(
    companyId: string,
    input: RoutingInput,
    mode: RoutedMode = 'dedicated',
  ): Promise<IndexerBinding[]> {
    const bindings = await this.bindingsFor(companyId);
    const { selected, needEmbedding } = routeByRules(bindings, input, mode);
    // Embedding matches are ranked by similarity so the per-document cap
    // keeps the MOST relevant packs. Rule-selected packs (explicit request /
    // vertical / alwaysRun / keyword) come first — they are deterministic
    // triggers, not guesses.
    const viaEmbedding = await this.routeByEmbedding(needEmbedding, input);
    const ranked = [...selected, ...viaEmbedding];
    const cap = maxDedicatedPerDoc();
    const all = ranked.slice(0, cap);
    if (ranked.length > cap) {
      this.logger.warn(
        `router: capped ${mode} indexers ${ranked.length}→${cap} for a ${input.vertical} document (dropped ${ranked
          .slice(cap)
          .map((b) => b.indexerId)
          .join(', ')})`,
      );
    }
    traceArtifact('indexer.route', {
      vertical: input.vertical,
      mode,
      requested: input.requested,
      selected: all.map((b) => b.indexerId),
      viaEmbedding: viaEmbedding.map((b) => b.indexerId),
      cappedFrom: ranked.length,
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
    const matched: Array<{ binding: IndexerBinding; sim: number }> = [];
    for (const b of candidates) {
      try {
        // Pack descriptions are stable strings — the embedder's LRU makes
        // this a one-time cost per pack per process.
        const descVec = await this.embedder.embed(b.relevance!.description!);
        const sim = cosineSimilarity(headVec, descVec);
        if (sim >= (b.relevance?.threshold ?? DEFAULT_RELEVANCE_THRESHOLD)) {
          matched.push({ binding: b, sim });
        }
      } catch (e) {
        this.logger.warn(`router L2 embed failed for pack ${b.indexerId}: ${(e as Error).message}`);
      }
    }
    return matched.sort((a, b) => b.sim - a.sim).map((m) => m.binding);
  }

  private async installedManifests(companyId: string): Promise<DomainPackManifest[]> {
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const rows = await queryRows<{ manifest: DomainPackManifest }>(
          db,
          `SELECT manifest FROM domain_pack WHERE status = 'active'`,
        );
        return rows.map((r) => r.manifest).filter(Boolean);
      });
    } catch (e) {
      this.logger.warn(
        `router: reading installed packs failed for ${companyId}: ${(e as Error).message}`,
      );
      return [];
    }
  }
}

/** Upper bound on dedicated indexers per document — the LLM-call fan-out is
 *  chunks × selected packs × sc-passes, so this is the last cost backstop. */
function maxDedicatedPerDoc(): number {
  const v = Number(process.env.MAX_DEDICATED_INDEXERS_PER_DOC);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 8;
}
