import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { cosineSimilarity } from '../common/vector-math';

/**
 * CommunityService — read surface over the topic communities that
 * CommunityBuilderService persists off-hours. This is the graphiti-style
 * community retrieval SCOPE: coarse, summary-level answers to
 * "what do we know about <domain>" without scanning the fact firehose.
 *
 * Kept separate from the builder so the MCP/read path doesn't drag in the
 * SUMMARY_GENERATOR / build machinery. Cosine search mirrors
 * ProceduralMemoryService.match — JS-side over a small N (communities are
 * O(10²), not O(facts)); we revisit server-side vector::similarity only if
 * a tenant's community count ever justifies an HNSW index.
 */
@Injectable()
export class CommunityService {
  private readonly logger = new Logger(CommunityService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  /** Paginated listing for review UIs / agent enumeration. */
  async list(
    companyId: string,
    args: { limit?: number; callerScopes?: readonly string[] } = {},
  ): Promise<CommunityRecord[]> {
    return this.run(companyId, args.callerScopes, async (db) => {
      const [rows] = await db.query<[RawCommunity[]]>(
        `SELECT id, label, summary, memberCount, builtAt, lastBuiltMaxEdgeAt
           FROM community_node
           ORDER BY memberCount DESC, builtAt DESC
           LIMIT $limit`,
        { limit: args.limit ?? 50 },
      );
      return ((rows as RawCommunity[]) ?? []).map(mapCommunity);
    });
  }

  /**
   * Cosine-match communities by their summary embedding against a
   * free-text query. The coarse retrieval scope: returns topic clusters
   * relevant to the query, each with its LLM/concat summary.
   */
  async search(
    companyId: string,
    args: {
      query: string;
      limit?: number;
      minSimilarity?: number | undefined;
      callerScopes?: readonly string[];
    },
  ): Promise<ScoredCommunity[]> {
    return this.run(companyId, args.callerScopes, async (db) => {
      const q = await this.embedder.embed(args.query);
      const [rows] = await db.query<[RawCommunity[]]>(
        `SELECT id, label, summary, memberCount, builtAt, summaryEmbedding
           FROM community_node
           WHERE summaryEmbedding != NONE`,
      );
      const minSim = args.minSimilarity ?? 0.3;
      const limit = args.limit ?? 5;

      const scored: ScoredCommunity[] = [];
      for (const r of (rows as RawCommunity[]) ?? []) {
        const emb = Array.isArray(r.summaryEmbedding) ? r.summaryEmbedding : null;
        if (!emb) continue;
        const sim = cosineSimilarity(q, emb);
        if (sim < minSim) continue;
        scored.push({ ...mapCommunity(r), similarity: sim });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, limit);
    });
  }

  /**
   * Which communities an entity belongs to. Cheap entity→community lookup
   * over the `member_out_idx`. Consumed by the REST/MCP surface only —
   * no retrieval stage reads communities (graph research 2026-08: the
   * once-planned reranker type-hint was never built, and community
   * summaries for factoid QA have zero positive ablations externally;
   * the offline-aggregation slot is occupied by the digest lane).
   */
  async forEntity(
    companyId: string,
    entityId: string,
    callerScopes?: readonly string[],
  ): Promise<CommunityRecord[]> {
    return this.run(companyId, callerScopes, async (db) => {
      const eid = toRecordId(entityId);
      const [rows] = await db.query<[Array<{ in: unknown }>]>(
        `SELECT in FROM community_member WHERE out = $eid`,
        { eid },
      );
      const cids = ((rows as Array<{ in: unknown }>) ?? []).map(
        (r) => new StringRecordId(String(r.in)),
      );
      if (cids.length === 0) return [];
      const [communities] = await db.query<[RawCommunity[]]>(
        `SELECT id, label, summary, memberCount, builtAt
           FROM community_node WHERE id INSIDE $cids
           ORDER BY memberCount DESC`,
        { cids },
      );
      return ((communities as RawCommunity[]) ?? []).map(mapCommunity);
    });
  }

  /**
   * Caller-facing reads (REST controller, MCP tools) thread scopes and
   * ride the SCOPED pool — community rows carry LLM summaries synthesized
   * from facts. NOTE (R4 audit): the DB-level PERMISSIONS fence does NOT
   * fire for the system `brain_caller` user; the application-layer filter
   * is the effective barrier. The scoped pool is kept for the future
   * Record Access track. Internal consumers (reranker type hints, builder)
   * stay on the root pool.
   */
  private run<T>(
    companyId: string,
    callerScopes: readonly string[] | undefined,
    fn: Parameters<SurrealService['withCompany']>[1],
  ): Promise<T> {
    return (
      callerScopes
        ? this.surreal.withScopedCompany(companyId, callerScopes, fn)
        : this.surreal.withCompany(companyId, fn)
    ) as Promise<T>;
  }
}

function toRecordId(raw: string): StringRecordId {
  return new StringRecordId(raw.startsWith('knowledge_entity:') ? raw : `knowledge_entity:${raw}`);
}

function mapCommunity(r: RawCommunity): CommunityRecord {
  return {
    communityId: String(r.id),
    label: String(r.label ?? ''),
    summary: String(r.summary ?? ''),
    memberCount: typeof r.memberCount === 'number' ? r.memberCount : 0,
    builtAt: toIso(r.builtAt),
  };
}

function toIso(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return String(v);
}

interface RawCommunity {
  id: unknown;
  label?: string;
  summary?: string;
  memberCount?: number;
  builtAt?: unknown;
  lastBuiltMaxEdgeAt?: unknown;
  summaryEmbedding?: number[];
}

export interface CommunityRecord {
  communityId: string;
  label: string;
  summary: string;
  memberCount: number;
  builtAt: string;
}

export interface ScoredCommunity extends CommunityRecord {
  similarity: number;
}
