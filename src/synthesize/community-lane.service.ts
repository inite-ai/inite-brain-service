import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { sameWidthGate } from '../db/vector-width';
import { rrfFuse } from './segment-lane.service';

/** Community summaries surfaced per answer — GraphRAG's local-first read takes the top few. */
const COMMUNITY_LIMIT = 3;

/** Candidates each leg ranks before fusion. */
const LEG_K = 10;

interface CommunityRow {
  id: unknown;
  label: string;
  summary: string;
  lastBuiltAt?: Date | string | null;
  builtAt?: Date | string | null;
}

/**
 * Community lane (#876) — the read side of the community summaries the
 * dreams pass builds every night (community_node, 0036), for questions
 * about a whole topic ("what are the main themes", "summarise what we
 * know about the payments project"). GraphRAG global search, local-first
 * variant (LazyGraphRAG / DRIFT): rank the summaries against the query
 * with BM25 over `summary` and cosine over `summaryEmbedding`, fuse by
 * RRF, and hand the top few to the prompt's insight slot — no map-reduce
 * over every community with a model.
 *
 * The caller gates on the summary lane: community summaries carry no
 * positive ablation for factoid questions, and the slot is spent only
 * where the question is about a topic.
 *
 * A summary is a snapshot. One whose members gained a live edge after it
 * was built is skipped — it no longer describes the graph — and the rest
 * carry their build date, so the generator sees how old the overview is.
 *
 * Scope: a community summary is tenant-wide by construction — the
 * builder folds only tenant-global, non-PII, untagged rows
 * (community-builder.service.ts) — so every caller of the tenant may read
 * it. Same contracts as the sibling lanes: degrade to [] on any failure,
 * no env reads.
 */
@Injectable()
export class CommunityLaneService {
  private readonly logger = new Logger(CommunityLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async communityLines(opts: { companyId: string; query: string }): Promise<string[]> {
    try {
      const q = await this.embedder.embed(opts.query);
      const rows = await this.surreal.withCompany(opts.companyId, async (db) => {
        // One round-trip: both legs rank in the database, and freshness is
        // computed where the edges live — live tenant-global edges between
        // two members (the set the builder folds) created after the
        // build's watermark. Only the RRF over ≤ 2·LEG_K ids runs here.
        const out = await db.query<unknown[]>(
          `LET $lex = (SELECT VALUE id FROM (SELECT id, search::score(1) AS score
              FROM community_node WHERE summary @1@ $text ORDER BY score DESC LIMIT ${LEG_K}));
           LET $vec = (SELECT VALUE id FROM (SELECT id,
                vector::similarity::cosine(summaryEmbedding, $q) AS score FROM community_node
              WHERE ${sameWidthGate('summaryEmbedding')} ORDER BY score DESC LIMIT ${LEG_K}));
           RETURN {
             lex: $lex,
             vec: $vec,
             rows: (SELECT id, label, summary, lastBuiltAt, builtAt,
                 count(SELECT id FROM knowledge_edge
                   WHERE in INSIDE $parent->community_member.out
                     AND out INSIDE $parent->community_member.out
                     AND invalidatedAt IS NONE AND userId IS NONE AND (scope ?? []) = []
                     AND $parent.lastBuiltMaxEdgeAt != NONE
                     AND createdAt > $parent.lastBuiltMaxEdgeAt) AS newerEdges
               FROM community_node WHERE id INSIDE array::union($lex, $vec))
           };`,
          { text: opts.query, q },
        );
        const ranked = out[out.length - 1] as
          | { lex: unknown[]; vec: unknown[]; rows: Array<CommunityRow & { newerEdges: number }> }
          | undefined;
        if (!ranked) return [];
        const byId = new Map(ranked.rows.map((r) => [String(r.id), r]));
        return rrfFuse([ranked.lex.map((id) => ({ id })), ranked.vec.map((id) => ({ id }))])
          .map(({ id }) => byId.get(String(id)))
          .filter((r): r is CommunityRow & { newerEdges: number } => !!r && !r.newerEdges);
      });
      return rows
        .filter((r) => r.summary?.trim())
        .slice(0, COMMUNITY_LIMIT)
        .map(
          (r) =>
            `Topic overview — ${r.label} (built ${day(r.lastBuiltAt ?? r.builtAt)}):\n${r.summary}`,
        );
    } catch (e) {
      this.logger.warn(
        `community lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }
}

function day(v: Date | string | null | undefined): string {
  if (!v) return 'unknown';
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
