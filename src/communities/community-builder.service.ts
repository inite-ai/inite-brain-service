import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { withSpan } from '../common/tracing';
import {
  SUMMARY_GENERATOR,
} from '../compaction/compaction.service';
import type {
  FactToSummarize,
  SummaryGenerator,
} from '../compaction/summary-generator';
import {
  buildAdjacency,
  labelPropagation,
} from './label-propagation';

/**
 * CommunityBuilderService — clusters the tenant's entity graph into
 * topic communities (label propagation over `knowledge_edge`),
 * summarises each, and persists `community_node` + `community_member`.
 *
 * Borrowed from graphiti's community layer. The off-hours dreams loop
 * runs `run(db)` per tenant (gated by DREAMS_COMMUNITIES_ENABLED).
 *
 * WATERMARK (graphiti `summarize_saga`): each community records
 * `lastBuiltMaxEdgeAt` — the newest `knowledge_edge.createdAt` that fed
 * the cluster. On the next build, a community whose member set is
 * unchanged AND whose freshest internal edge is no newer than the stored
 * watermark is REUSED verbatim — no re-summarisation, no embedding spend.
 * Only genuinely changed clusters re-pay the cost.
 *
 * Stateless: the caller (DreamsService) owns connection + tenant scoping.
 */
@Injectable()
export class CommunityBuilderService {
  private readonly logger = new Logger(CommunityBuilderService.name);
  private readonly enabled: boolean;
  private readonly minSize: number;
  private readonly maxIterations: number;
  private readonly summaryMaxMembers: number;

  constructor(
    private readonly config: ConfigService,
    private readonly embedder: EmbedderService,
    @Inject(SUMMARY_GENERATOR)
    private readonly summaryGenerator: SummaryGenerator,
  ) {
    this.enabled =
      this.config.get<string>('DREAMS_COMMUNITIES_ENABLED', '0') === '1';
    this.minSize = parseInt(
      this.config.get<string>('COMMUNITIES_MIN_SIZE', '3'),
      10,
    );
    this.maxIterations = parseInt(
      this.config.get<string>('COMMUNITIES_MAX_ITERATIONS', '10'),
      10,
    );
    this.summaryMaxMembers = parseInt(
      this.config.get<string>('COMMUNITIES_SUMMARY_MAX_MEMBERS', '10'),
      10,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Build (or incrementally refresh) communities for ONE tenant over the
   * passed `db` handle. Idempotent: a second run with no graph change
   * reuses every community via the watermark and creates/deletes nothing.
   */
  async run(db: Surreal): Promise<CommunityBuildResult> {
    const result: CommunityBuildResult = {
      communitiesBuilt: 0,
      communitiesReused: 0,
      communitiesRemoved: 0,
      entitiesClustered: 0,
    };
    if (!this.enabled) return result;

    const edges = await this.loadEdges(db);
    if (edges.length === 0) {
      // No edges → no communities. Still drop any stale ones left over
      // from a prior denser graph so the scope doesn't serve ghosts.
      result.communitiesRemoved = await this.removeAllCommunities(db);
      return result;
    }

    const adjacency = buildAdjacency(
      edges.map((e) => ({ from: e.from, to: e.to, weight: e.weight })),
    );
    const clusters = labelPropagation(adjacency, this.maxIterations).filter(
      (c) => c.length >= this.minSize,
    );

    // Per-cluster newest internal edge (event-time watermark). An edge is
    // "internal" when both endpoints sit in the same cluster.
    const clusterOf = new Map<string, number>();
    clusters.forEach((members, i) => members.forEach((m) => clusterOf.set(m, i)));
    const maxEdgeAt: Array<string | null> = clusters.map(() => null);
    for (const e of edges) {
      const ci = clusterOf.get(e.from);
      if (ci === undefined || clusterOf.get(e.to) !== ci) continue;
      if (e.createdAt && (maxEdgeAt[ci] === null || e.createdAt > maxEdgeAt[ci]!)) {
        maxEdgeAt[ci] = e.createdAt;
      }
    }

    const existing = await this.loadExistingCommunities(db);
    const matchedExistingIds = new Set<string>();

    for (let i = 0; i < clusters.length; i++) {
      const members = clusters[i];
      result.entitiesClustered += members.length;
      const signature = members.join('|');
      const prior = existing.get(signature);

      // WATERMARK skip: identical member set and no newer internal edge.
      if (
        prior &&
        prior.lastBuiltMaxEdgeAt &&
        maxEdgeAt[i] &&
        prior.lastBuiltMaxEdgeAt >= maxEdgeAt[i]!
      ) {
        matchedExistingIds.add(prior.id);
        result.communitiesReused++;
        continue;
      }

      // (Re)build this cluster. If a community with the identical member
      // set existed (but is now stale), delete it first so we don't leave
      // a duplicate.
      if (prior) {
        await this.deleteCommunity(db, prior.id);
        matchedExistingIds.add(prior.id);
      }
      await withSpan(
        'communities.build_one',
        () => this.buildCommunity(db, members, maxEdgeAt[i]),
        { 'community.size': members.length },
      );
      result.communitiesBuilt++;
    }

    // Remove communities whose member set no longer corresponds to any
    // current cluster (the graph drifted).
    for (const [, prior] of existing) {
      if (matchedExistingIds.has(prior.id)) continue;
      await this.deleteCommunity(db, prior.id);
      result.communitiesRemoved++;
    }

    this.logger.log(
      `[communities] built=${result.communitiesBuilt} reused=${result.communitiesReused} ` +
        `removed=${result.communitiesRemoved} entitiesClustered=${result.entitiesClustered}`,
    );
    return result;
  }

  /** Load every live entity-entity edge. Mirrors ppr.ts edge-load. */
  private async loadEdges(db: Surreal): Promise<EdgeRow[]> {
    type Raw = { in: unknown; out: unknown; weight?: number; createdAt?: unknown };
    const [rows] = await db.query<[Raw[]]>(
      `SELECT in, out, weight, createdAt FROM knowledge_edge
         WHERE invalidatedAt IS NONE`,
    );
    return ((rows as Raw[]) ?? []).map((r) => ({
      from: String(r.in),
      to: String(r.out),
      weight: typeof r.weight === 'number' ? r.weight : 1.0,
      createdAt: toIso(r.createdAt),
    }));
  }

  private async loadExistingCommunities(
    db: Surreal,
  ): Promise<Map<string, ExistingCommunity>> {
    type Raw = { id: unknown; lastBuiltMaxEdgeAt?: unknown };
    const [rows] = await db.query<[Raw[]]>(
      `SELECT id, lastBuiltMaxEdgeAt FROM community_node`,
    );
    const comms = (rows as Raw[]) ?? [];
    const out = new Map<string, ExistingCommunity>();
    if (comms.length === 0) return out;

    // One batched member fetch instead of one query per community (N+1).
    const cids = comms.map((r) => new StringRecordId(String(r.id)));
    const [memberRows] = await db.query<[Array<{ in: unknown; out: unknown }>]>(
      `SELECT in, out FROM community_member WHERE in INSIDE $cids`,
      { cids },
    );
    const membersByComm = new Map<string, string[]>();
    for (const m of (memberRows as Array<{ in: unknown; out: unknown }>) ?? []) {
      const cid = String(m.in);
      const arr = membersByComm.get(cid);
      if (arr) arr.push(String(m.out));
      else membersByComm.set(cid, [String(m.out)]);
    }
    for (const r of comms) {
      const cid = String(r.id);
      const members = (membersByComm.get(cid) ?? []).sort();
      out.set(members.join('|'), {
        id: cid,
        lastBuiltMaxEdgeAt: toIso(r.lastBuiltMaxEdgeAt) || null,
      });
    }
    return out;
  }

  /** Summarise + embed + persist one community and its member edges. */
  private async buildCommunity(
    db: Surreal,
    members: string[],
    maxEdgeAt: string | null,
  ): Promise<void> {
    const { label, summaryInput } = await this.gatherMemberContext(db, members);
    const summary = await this.summaryGenerator.generate(summaryInput);
    const summaryEmbedding = summary
      ? await this.embedder.embed(summary)
      : null;

    // lastBuiltMaxEdgeAt is option<datetime>: OMIT it (leave NONE) when the
    // cluster has no dated internal edge, rather than passing NULL — a JS
    // null does not satisfy option<datetime> on a SCHEMAFULL field. The
    // field is last in CONTENT so the conditional comma stays simple. A JS
    // Date serialises as a native datetime (a `d$param` cast won't parse
    // inside a CONTENT value).
    const params: Record<string, unknown> = {
      label,
      summary,
      embedding: summaryEmbedding,
      count: members.length,
    };
    let edgeClause = '';
    if (maxEdgeAt) {
      edgeClause = ',\n         lastBuiltMaxEdgeAt: $maxEdgeAt';
      params.maxEdgeAt = new Date(maxEdgeAt);
    }
    const [created] = await db.query<[Array<{ id: unknown }>]>(
      `CREATE community_node CONTENT {
         label: $label,
         summary: $summary,
         summaryEmbedding: $embedding,
         memberCount: $count,
         algorithm: 'label_propagation',
         builtAt: time::now(),
         lastBuiltAt: time::now()${edgeClause}
       }`,
      params,
    );
    const cid = String(((created as Array<{ id: unknown }>) ?? [])[0]?.id ?? '');
    if (!cid) throw new Error('community_node CREATE returned no id');

    // Batch all member edges into one round-trip: a multi-statement query
    // with indexed params (avoids a per-member round-trip; a SurrealQL FOR
    // loop has a known scoping gotcha we sidestep here).
    if (members.length > 0) {
      const relateParams: Record<string, unknown> = {
        cid: new StringRecordId(cid),
      };
      const stmts = members
        .map((eid, i) => {
          relateParams[`e${i}`] = new StringRecordId(eid);
          return `RELATE $cid->community_member->$e${i} SET addedAt = time::now();`;
        })
        .join('\n');
      await db.query(stmts, relateParams);
    }
  }

  /**
   * Build the summary input for a community: the highest-degree member's
   * canonical name becomes the label; a bounded sample of members'
   * top-confidence facts feeds the SummaryGenerator. Reusing the
   * (entity-shaped) FactToSummarize contract keeps us on the existing
   * SUMMARY_GENERATOR — concat by default, LLM behind the flag.
   */
  private async gatherMemberContext(
    db: Surreal,
    members: string[],
  ): Promise<{ label: string; summaryInput: FactToSummarize[] }> {
    const sample = members.slice(0, this.summaryMaxMembers);
    const ridSample = sample.map((m) => new StringRecordId(m));

    // Member display names — label off the first, summary lists the rest.
    const [nameRows] = await db.query<[Array<{ id: unknown; canonicalName: string }>]>(
      `SELECT id, canonicalName FROM knowledge_entity WHERE id INSIDE $ids`,
      { ids: ridSample },
    );
    const names = (nameRows as Array<{ id: unknown; canonicalName: string }>) ?? [];
    const label =
      names[0]?.canonicalName ?? `community of ${members.length} entities`;

    const [factRows] = await db.query<[Array<RawFact>]>(
      `SELECT entityId, predicate, object, confidence, validFrom, validUntil
         FROM knowledge_fact
         WHERE entityId INSIDE $ids
           AND status = 'active'
           AND retractedAt IS NONE
         ORDER BY confidence DESC
         LIMIT 40`,
      { ids: ridSample },
    );
    const summaryInput: FactToSummarize[] = (
      (factRows as RawFact[]) ?? []
    ).map((f) => ({
      factId: String(f.entityId),
      predicate: f.predicate,
      object: f.object,
      validFrom: toIso(f.validFrom),
      validUntil: f.validUntil ? toIso(f.validUntil) : undefined,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.5,
    }));
    return { label, summaryInput };
  }

  private async deleteCommunity(db: Surreal, cid: string): Promise<void> {
    const rid = new StringRecordId(cid);
    await db.query(`DELETE community_member WHERE in = $cid`, { cid: rid });
    await db.query(`DELETE $cid`, { cid: rid });
  }

  private async removeAllCommunities(db: Surreal): Promise<number> {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM community_node`,
    );
    const ids = ((rows as Array<{ id: unknown }>) ?? []).map((r) => String(r.id));
    for (const cid of ids) await this.deleteCommunity(db, cid);
    return ids.length;
  }
}

export interface CommunityBuildResult {
  communitiesBuilt: number;
  communitiesReused: number;
  communitiesRemoved: number;
  entitiesClustered: number;
}

interface EdgeRow {
  from: string;
  to: string;
  weight: number;
  createdAt: string;
}

interface ExistingCommunity {
  id: string;
  lastBuiltMaxEdgeAt: string | null;
}

interface RawFact {
  entityId: unknown;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: unknown;
  validUntil?: unknown;
}

/**
 * Normalise SurrealDB datetime / record values to a comparable ISO
 * string. ISO-8601 sorts lexicographically, so we compare watermarks as
 * plain strings. Empty string for nullish input.
 */
function toIso(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return String(v);
}
