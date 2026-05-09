import { Injectable, Logger, Optional } from '@nestjs/common';
import { Surreal, StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { RerankerService } from '../ai/reranker.service';
import { PredicateRouterService } from '../ai/predicate-router.service';
import { CrossEncoderService } from '../ai/cross-encoder.service';
import { SearchDto, SearchMode } from './dto/search.dto';
import { policyFor } from '../ingest/conflict-resolver';
import { countJsonTokens } from '../common/token-counter';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';

export interface SearchHit {
  entityId: string;
  entityType: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string;
    status: string;
    score: number;
  }>;
  score: number;
}

interface FactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
  retractedAt?: string;
  status: string;
  source: any;
  // Hydrated via inline projection — entity record inlined.
  entity?: {
    id: unknown;
    type: string;
    canonicalName: string;
    externalRefs?: Record<string, string>;
    mergedInto?: unknown;
  };
  // One of these is set per row depending on which leg surfaced it;
  // hybrid mode merges both and lets RRF fuse. Field names sidestep the
  // SurrealQL `vec::*` and `lex::*` namespace prefixes — using `vec` or
  // `lex` as a SELECT alias confuses the parser's `ORDER BY` resolver
  // and silently returns rows in record-id order instead of by score.
  simScore?: number;
  bm25Score?: number;
}

// Convex combination weight for hybrid fusion. 0.5 = equal trust in
// vector and lexical legs. We deliberately avoid pure rank-based RRF
// (Cormack et al. 2009) — measured: recall@1 0.85 (convex) → 0.43
// (RRF k=60) on the quality eval. For our small per-tenant scale
// (hundreds of facts), ranks are too coarse — a perfect cosine match
// (≈1.0) and a weak match (≈0.05) both end up at rank 1 if no better
// candidate exists, and RRF treats them as equivalent.
//
// CombMNZ consensus boost was also tested (×1.3 when both legs hit) —
// no measurable improvement (median 0.82 vs 0.84 baseline). Most
// queries are dominated by a single leg; boosting both-leg agreement
// occasionally promotes consensus on noise. Reverted.
const HYBRID_VECTOR_WEIGHT = 0.5;

/**
 * Diversity-bucket key for the degree boost. Two facts collapse
 * to the same key when they have the same predicate AND their
 * normalized leading 3 tokens overlap — close enough to treat
 * them as the same piece of evidence (e.g. "broken washing
 * machine in unit 4B" and "washing machine broken since Tuesday"
 * share `complained_about|broken washing machine`).
 *
 * The bound is intentionally coarse: we want to penalize obvious
 * near-duplicates from LLM-extraction noise, not finely cluster
 * facts. Token-overlap fuzziness lives downstream in the
 * cross-encoder reranker (next milestone).
 */
function diversityKey(predicate: string, object: string): string {
  const tokens = object
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 3)
    .sort()
    .join(' ');
  return `${predicate}|${tokens}`;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly reranker: RerankerService,
    private readonly predicateRouter: PredicateRouterService,
    private readonly crossEncoder: CrossEncoderService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Decide whether the LLM reranker can be skipped based on the
   * fused-score margin between the current top-1 and top-2 entities.
   *
   * Relative margin: `(top1 − top2) / top1 ≥ marginThreshold`. We use
   * the relative form because `rankScore` is post-degree-boost and not
   * normalised to [0, 1] — an absolute threshold would behave wildly
   * differently across queries with sparse vs dense candidate sets.
   *
   * Returns false when:
   *   - threshold ≤ 0 (feature disabled)
   *   - candidate set ≤ 1 (no rerank target anyway)
   *   - top1 score is non-positive (degenerate / empty result)
   *   - the gap is below threshold (LLM call still earns its keep)
   *
   * Pure function exported for unit testing — keeps the inline call
   * site in `search()` minimal.
   */
  static shouldSkipRerankByMargin(
    candidates: Array<{ rankScore: number }>,
    marginThreshold: number,
  ): boolean {
    if (marginThreshold <= 0) return false;
    if (candidates.length < 2) return false;
    const top = candidates[0].rankScore;
    if (top <= 0) return false;
    const gap = (top - candidates[1].rankScore) / top;
    return gap >= marginThreshold;
  }

  async search(
    companyId: string,
    dto: SearchDto,
    callerScopes: string[],
  ): Promise<{ results: SearchHit[] }> {
    const limit = dto.limit ?? 10;
    const asOf = dto.asOf ? new Date(dto.asOf) : null;
    const includeRetracted = dto.includeRetracted ?? false;
    const includeContested = dto.includeContested ?? true;
    const mode: SearchMode = dto.searchMode ?? 'hybrid';

    // Pull more candidates than `limit` so RRF / decay weighting can
    // re-rank without starving the top-K. 5× is empirically a good
    // trade-off — enough headroom for fusion to matter, not so many
    // that we shovel embeddings across the wire for nothing.
    const candidateK = Math.min(limit * 5, 200);

    return this.surreal.withScopedCompany(companyId, callerScopes, async (db) => {
      // Bitemporal predicates pushed into WHERE — no JS post-filter.
      // The composite (entityId, status, recordedAt) index covers
      // entity scope; full-table scans here only run when there's no
      // entity filter, which is the common case for free-text search.
      const baseWhere = this.buildBaseWhere(dto, asOf, includeRetracted, includeContested);

      const [vectorRows, lexicalRows] = await Promise.all([
        mode === 'lexical'
          ? Promise.resolve([] as FactRow[])
          : withSpan(
              'search.vector_leg',
              async (span) => {
                const rows = await this.vectorLeg(
                  db,
                  dto.query,
                  candidateK,
                  baseWhere,
                );
                span.setAttribute('candidates', rows.length);
                return rows;
              },
              { 'search.k': candidateK },
            ),
        mode === 'vector'
          ? Promise.resolve([] as FactRow[])
          : withSpan(
              'search.lexical_leg',
              async (span) => {
                const rows = await this.lexicalLeg(
                  db,
                  dto.query,
                  candidateK,
                  baseWhere,
                );
                span.setAttribute('candidates', rows.length);
                return rows;
              },
              { 'search.k': candidateK },
            ),
      ]);

      // Fuse — vector and lexical lists are joined by fact id; the
      // resulting per-fact score is RRF(vector_rank, lexical_rank)
      // when both legs contributed, or the single-leg score otherwise.
      const fused = this.fuse(vectorRows, lexicalRows, mode);

      // Identity-merge re-attribution. When an entity has been merged
      // into another via a kind='identity_of' link, its `mergedInto`
      // field points to the survivor. Re-key facts from the loser to
      // the survivor and merge the loser's externalRefs into the
      // survivor display so the result set shows ONE entity carrying
      // facts from both verticals — matching the operator's mental
      // model after declaring "these are the same person".
      const survivorRecords = await this.hydrateSurvivors(db, fused);
      const reattributed = this.reattributeMerged(fused, survivorRecords);

      // Apply policy gates AFTER fusion: predicate filter, scope gate,
      // confidence floor. Doing this post-fusion preserves recall —
      // a query that semantically matches but is filtered by scope
      // returns zero rather than silently demoting.
      const filtered = reattributed.filter((row) => this.passesPolicy(row, dto, callerScopes));

      // Joint predicate + type router: single LLM call classifies
      // the query into BOTH a predicate-class distribution and a
      // target-entity-type distribution. Predicate boost applies
      // per-fact (a fact's predicate matching the query's intent
      // class). Type boost applies per-entity at the bucket stage
      // (an entity's type matching the query's target class —
      // fixes "Project Phoenix kickoff" preferring staff over
      // the project entity).
      // Returns null when the router is disabled or the LLM call
      // fails — both boosts reduce to 1.0.
      const routerOut = await withSpan('search.route', async (span) => {
        const out = await this.predicateRouter.route(dto.query);
        span.setAttribute('router.hit', out !== null);
        return out;
      });
      const predicateDist = routerOut?.predicates ?? null;
      const typeDist = routerOut?.types ?? null;

      // Decay-weighted final score uses predicate half-life. Vector
      // and lexical fusion give us a normalized retrieval score in
      // [0, 1); we multiply by decay × confidence × predicate-boost
      // as the final ranking signal.
      const now = Date.now();
      // PREDICATE_BOOST_ALPHA caps the boost at 1 + alpha*1.0 = 1.5x
      // for a perfect predicate match, 1.0x for a missed class.
      // Soft enough that a strong embedding hit on the wrong
      // predicate can still beat a weak hit on the right one.
      const PREDICATE_BOOST_ALPHA = 0.5;
      const scored = filtered.map((row) => {
        const policy = policyFor(row.predicate);
        const ageDays = (now - new Date(row.recordedAt).getTime()) / 86_400_000;
        const decay = policy.decayHalfLifeDays === null
          ? 1
          : Math.exp((-Math.LN2 * ageDays) / policy.decayHalfLifeDays);
        const predBoost = predicateDist
          ? 1 + PREDICATE_BOOST_ALPHA * (predicateDist.weights[row.predicate] ?? 0)
          : 1;
        const finalScore = row.fusedScore * decay * row.confidence * predBoost;
        return { row, score: finalScore };
      });

      // Group by entity. Per-entity ranking score is best-fact-score
      // plus a bounded contribution from additional matched facts —
      // diversity-aware: only the best fact per (predicate,
      // object-prefix) tuple counts. This is a graph-degree signal
      // that prefers entities with breadth of evidence (multiple
      // genuinely distinct matching facts) over entities that flood
      // a single topic — without letting many-weak hits beat a
      // single-strong hit. The 0.3 weight keeps the dominant fact's
      // signal ≥ 70% of the final score.
      const DEGREE_BOOST_WEIGHT = 0.3;
      const DEGREE_BOOST_TOP_N = 2;
      const byEntity = new Map<string, { entityId: string; rankScore: number; bestScore: number; facts: typeof scored }>();
      for (const sf of scored) {
        const eid = String(sf.row.entityId);
        const bucket = byEntity.get(eid) ?? { entityId: eid, rankScore: 0, bestScore: 0, facts: [] };
        bucket.facts.push(sf);
        if (sf.score > bucket.bestScore) bucket.bestScore = sf.score;
        byEntity.set(eid, bucket);
      }
      // Compute aggregate rank score after all facts are bucketed.
      // Per-entity boost = sum of best-fact-score across the top
      // DEGREE_BOOST_TOP_N DISTINCT (predicate, normalized-prefix)
      // tuples (excluding the entity's overall-best fact, which is
      // already counted as bestScore). Prevents an entity with five
      // near-duplicate complained_about facts from accumulating a
      // boost five times for what is essentially one piece of
      // evidence.
      //
      // Note: type-aware boost was tested at this stage and dropped
      // — the downstream reranker re-orders top-20 anyway, so
      // pre-rerank type-multiplication just disrupted fusion scores
      // without net gain. Type-prior is now passed as a hint INSIDE
      // the reranker prompt instead (see rerank inputs below).
      for (const bucket of byEntity.values()) {
        const sortedFacts = [...bucket.facts].sort((a, b) => b.score - a.score);
        const seenKeys = new Set<string>();
        const supplementary: number[] = [];
        for (const f of sortedFacts) {
          const key = diversityKey(f.row.predicate, f.row.object);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          if (f.score === bucket.bestScore && supplementary.length === 0) continue;
          supplementary.push(f.score);
          if (supplementary.length >= DEGREE_BOOST_TOP_N) break;
        }
        const boost = supplementary.reduce((acc, s) => acc + s, 0);
        bucket.rankScore = bucket.bestScore + DEGREE_BOOST_WEIGHT * boost;
      }

      // Personalized PageRank entity prior — HippoRAG-style. Seed
      // each candidate by its bestScore, propagate through the
      // typed-edge graph (mentioned_with, identity_of) for 3 power
      // iterations with α=0.85. Coherent clusters reinforce; an
      // isolated false match doesn't get the cluster lift.
      //
      // Tier gating: PPR is dangerous on small graphs (≤100 entities)
      // because hub effects amplify pathologically — a project entity
      // with 2 staff edges outranks each staff member individually
      // (cross recall@1 1.00 → 0.57 on the 30-entity eval). On larger
      // tenants (≥SEARCH_PPR_MIN_ENTITIES) hub effects dissipate into
      // longer-tailed neighbourhoods and PPR pays off. Either:
      //   - SEARCH_PPR_ENABLED=1 forces PPR regardless of size
      //   - SEARCH_PPR_AUTO_THRESHOLD=N enables PPR only when the
      //     candidate set is ≥ N (cheap proxy for tenant size — if
      //     the query already retrieved many candidates the graph
      //     is dense enough to support PPR).
      //
      // Both off → no PPR. The default is OFF on both, so PPR
      // remains opt-in.
      const pprForced = process.env.SEARCH_PPR_ENABLED === '1';
      const pprAutoThreshold = parseInt(
        process.env.SEARCH_PPR_AUTO_THRESHOLD ?? '0',
        10,
      );
      const pprAuto =
        pprAutoThreshold > 0 && byEntity.size >= pprAutoThreshold;
      if ((pprForced || pprAuto) && byEntity.size > 1) {
        await withSpan(
          'search.ppr',
          () => this.applyPprPrior(db, byEntity),
          { 'ppr.entities': byEntity.size },
        );
      }

      // Two-stage rerank window:
      //   1. Cross-encoder (Cohere Rerank, optional) reorders a WIDE
      //      window of fusion-sorted candidates. Joint query×document
      //      attention catches token-overlap signals pooled embeddings
      //      miss, and pre-prunes for the LLM stage so the LLM prompt
      //      stays small.
      //   2. LLM listwise reranker refines the surviving NARROW window.
      // When the cross-encoder is disabled we collapse straight to the
      // narrow window — same shape as before.
      const RERANK_WINDOW = Math.min(limit * 2, 20);
      const CROSS_ENCODER_WINDOW = this.crossEncoder.isEnabled()
        ? Math.min(
            parseInt(
              process.env.SEARCH_CROSS_ENCODER_WINDOW ?? '50',
              10,
            ) || 50,
            byEntity.size,
          )
        : RERANK_WINDOW;

      const wideCandidates = [...byEntity.values()]
        .sort((a, b) => b.rankScore - a.rankScore)
        .slice(0, CROSS_ENCODER_WINDOW);

      let candidatesForRerank = wideCandidates.slice(0, RERANK_WINDOW);

      if (this.crossEncoder.isEnabled() && wideCandidates.length > 1) {
        // Build inputs once — same shape feeds both cross-encoder
        // and LLM rerank stages. The LLM stage adds neighbours later
        // (per-candidate fetch happens inside its branch); the
        // cross-encoder runs on the lighter "label + top-3 facts"
        // body for speed and cost.
        const xInputs = wideCandidates.map((e) => {
          const ent = e.facts[0]?.row.entity ?? {
            type: 'other',
            canonicalName: e.entityId,
          };
          const topFacts = [...e.facts]
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((sf) => `- ${sf.row.predicate}: ${sf.row.object}`)
            .join('\n');
          return {
            label: `${ent.canonicalName} [${ent.type}]`,
            body: topFacts,
          };
        });
        const xPerm = await withSpan(
          'search.cross_encoder',
          () => this.crossEncoder.rerank(dto.query, xInputs),
          { 'cross_encoder.candidates': xInputs.length },
        );
        // Detect identity fallback (transport / parse failure) so the
        // metric distinguishes real lift from no-op error paths.
        const isIdentity = xPerm.every((idx, i) => idx === i);
        this.metrics?.countCrossEncoder(isIdentity ? 'error' : 'invoked');
        candidatesForRerank = xPerm
          .map((i) => wideCandidates[i])
          .slice(0, RERANK_WINDOW);
      } else if (!this.crossEncoder.isEnabled()) {
        this.metrics?.countCrossEncoder('skipped_disabled');
      } else {
        this.metrics?.countCrossEncoder('skipped_singleton');
      }

      let topEntities = candidatesForRerank;
      // Margin-based reranker skip. Relative threshold over the
      // post-degree-boost rankScore: when the leader's gap to #2 is
      // already wide, the LLM call rarely flips the top-K — skipping
      // saves an LLM round-trip per query and a chunk of OpenAI
      // budget. Default 0 (off); operators tune via env after
      // measuring rerank-flip rate on their workload.
      const rerankSkipMargin = parseFloat(
        process.env.SEARCH_RERANK_SKIP_MARGIN ?? '0',
      );
      const skipByMargin = SearchService.shouldSkipRerankByMargin(
        candidatesForRerank,
        rerankSkipMargin,
      );

      if (!this.reranker.isEnabled()) {
        this.metrics?.countRerank('skipped_disabled');
      } else if (candidatesForRerank.length <= 1) {
        this.metrics?.countRerank('skipped_singleton');
      } else if (skipByMargin) {
        this.metrics?.countRerank('skipped_margin');
      }

      if (
        this.reranker.isEnabled() &&
        candidatesForRerank.length > 1 &&
        !skipByMargin
      ) {
        // SubgraphRAG-style 1-hop neighbourhood injection. Fetch
        // each rerank candidate's outgoing + incoming edges in a
        // single batched query, then surface them as
        // "Connected to: …" lines in the candidate body. Lets the
        // reranker exploit structural context — fixes shared-
        // firstname disambiguation (e.g. Maya vs Rohit, both have
        // headphone complaints; whose neighbours match the query?)
        const neighboursByEntity = await withSpan(
          'search.fetch_neighbours',
          () =>
            this.fetchNeighbours(
              db,
              candidatesForRerank.map((e) => e.entityId),
            ),
          { 'neighbours.candidates': candidatesForRerank.length },
        );

        // Build compact summaries — best 3 facts + entity type +
        // up to 5 1-hop neighbours per candidate. Bounded so the
        // reranker prompt stays small.
        const rerankInputs = candidatesForRerank.map((e) => {
          const ent = e.facts[0]?.row.entity ?? {
            type: 'other',
            canonicalName: e.entityId,
          };
          const topFacts = [...e.facts]
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((sf) => `- ${sf.row.predicate}: ${sf.row.object}`)
            .join('\n');
          const nbrs = neighboursByEntity.get(e.entityId) ?? [];
          const nbrLine = nbrs.length
            ? `\nConnected to: ${nbrs
                .slice(0, 5)
                .map((n) => `${n.canonicalName} (${n.type}, ${n.kind})`)
                .join('; ')}`
            : '';
          return {
            label: `${ent.canonicalName} [${ent.type}]`,
            body: `${topFacts}${nbrLine}`,
          };
        });

        // Type-prior hint from the joint router (if enabled). Keeps
        // the reranker aware that "Project Phoenix kickoff" likely
        // targets a staff/customer entity, not the project itself.
        const hints = typeDist
          ? `Likely target entity types: ${
              Object.entries(typeDist.weights)
                .filter(([, w]) => w >= 0.15)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([t, w]) => `${t}=${w.toFixed(2)}`)
                .join(', ') || 'unspecified'
            }.`
          : undefined;

        const permutation = await withSpan(
          'search.rerank',
          () => this.reranker.rerank(dto.query, rerankInputs, hints),
          { 'rerank.candidates': rerankInputs.length },
        );
        topEntities = permutation.map((i) => candidatesForRerank[i]);
        this.metrics?.countRerank('invoked');
      }
      topEntities = topEntities.slice(0, limit);

      const fullResults: SearchHit[] = topEntities
        .filter((e) => {
          if (!dto.entityTypes) return true;
          const ent = e.facts[0]?.row.entity;
          return ent ? dto.entityTypes.includes(ent.type) : false;
        })
        .map((e) => {
          const ent = e.facts[0]?.row.entity ?? {
            id: e.entityId,
            type: 'other',
            canonicalName: e.entityId,
            externalRefs: {},
          };
          // Merge externalRefs across all facts in the bucket. After
          // identity-merge re-attribution, the bucket contains both
          // the survivor's own facts (carrying survivor refs only)
          // and the loser's facts (now carrying merged refs); the
          // union is the right display so cross-vertical refs all
          // resolve to the same hit.
          const mergedRefs: Record<string, string> = {};
          for (const sf of e.facts) {
            const refs = sf.row.entity?.externalRefs;
            if (refs) Object.assign(mergedRefs, refs);
          }
          return {
            entityId: e.entityId,
            entityType: ent.type,
            canonicalName: ent.canonicalName,
            externalRefs: mergedRefs,
            facts: e.facts
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map(({ row, score }) => ({
                factId: String(row.id),
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                validFrom: row.validFrom,
                validUntil: row.validUntil ?? undefined,
                status: row.status,
                score,
              })),
            score: e.bestScore,
          };
        });

      // ── KnowQL-lite post-processing ────────────────────────────
      // confidenceFloor: stricter than DTO.minConfidence (which gates
      // the raw fact field). This is applied AFTER decay×confidence
      // weighting, so it shapes "agent's confidence in the answer".
      let results = fullResults;
      if (dto.confidenceFloor !== undefined) {
        const floor = dto.confidenceFloor;
        results = results
          .map((r) => ({
            ...r,
            facts: r.facts.filter((f) => f.score >= floor),
          }))
          .filter((r) => r.facts.length > 0);
      }

      // requireProvenance: every fact must carry a non-empty source.
      // We can't peek source from the response shape (it's stripped
      // for over-the-wire size), but the row carried it; rebuild
      // the fact list from `e.facts` rows that have source.
      // Simpler v0: rely on `source` field roundtripping. For now,
      // the policy is enforced via the row-level filter at the leg
      // queries — every row already includes source.
      // Implementation note: we do the filter on the JS side because
      // the WHERE-time check would be `source != NONE` which is
      // already true for every fact (schema requires source).
      // The flag remains useful as an explicit caller-intent marker
      // but doesn't change the result set in 0.1.0. Documented.

      // outputShape: trim the response per shape.
      const shape = dto.outputShape ?? 'full';
      if (shape === 'compact') {
        results = results.map((r) => ({
          ...r,
          facts: r.facts.slice(0, 1).map((f) => ({
            ...f,
            score: undefined as unknown as number,
          })),
        }));
      } else if (shape === 'ids') {
        results = results.map((r) => ({
          entityId: r.entityId,
          entityType: r.entityType,
          canonicalName: r.canonicalName,
          externalRefs: {},
          facts: [],
          score: r.score,
        }));
      }

      // tokenBudget: drop entities (lowest-score first) until the
      // serialised payload fits. Tokens counted exactly via tiktoken
      // (cl100k_base) on the JSON-serialised body — same encoding the
      // downstream OpenAI/Anthropic billing uses, so the budget the
      // caller specifies is the budget they'll actually consume.
      if (dto.tokenBudget !== undefined) {
        const fitsBudget = (xs: SearchHit[]) =>
          countJsonTokens({ results: xs }) <= dto.tokenBudget!;
        while (results.length > 0 && !fitsBudget(results)) {
          results.pop();
        }
      }

      return { results };
    });
  }

  // ── Retrieval legs ───────────────────────────────────────────────

  /**
   * Vector leg — cosine similarity over `embedding`. The inline
   * projection `entityId.{...} AS entity` reads the linked entity
   * record in the same query, so no separate hydration round-trip is
   * needed. We deliberately don't add `FETCH entityId` — that would
   * overwrite the `entityId` field in-place with the entity object,
   * breaking `String(row.entityId)` for the grouping pass below.
   * The inline-projection form keeps `entityId` as a record link
   * AND surfaces `entity` as a hydrated record.
   */
  private async vectorLeg(
    db: Surreal,
    query: string,
    k: number,
    baseWhere: { sql: string; params: Record<string, unknown> },
  ): Promise<FactRow[]> {
    const queryEmbedding = await this.embedder.embed(query);
    // simScore = max(cosine(main_embedding, q), cosine(alt_embedding, q))
    // — HyPE: alt is the embedding of a hypothetical question the
    // fact answers (migration 0008). Closes the question→statement
    // gap without paying an LLM call on the read path. NONE alt
    // (legacy facts or HyPE disabled) contributes -1 so it never
    // wins the max; the main embedding is always the floor.
    const sql = `
      SELECT
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity,
        math::max([
          vector::similarity::cosine(embedding, $q),
          IF altEmbedding != NONE THEN vector::similarity::cosine(altEmbedding, $q) ELSE -1 END
        ]) AS simScore
      FROM knowledge_fact
      WHERE embedding != NONE
        ${baseWhere.sql}
      ORDER BY simScore DESC
      LIMIT $k
    `;
    const [rows] = await db.query<[FactRow[]]>(sql, {
      ...baseWhere.params,
      q: queryEmbedding,
      k,
    });
    return (rows as FactRow[]) ?? [];
  }

  /**
   * Lexical leg — BM25 over the `searchHaystack` (predicate + object,
   * migration 0007) and `object` (legacy index, migration 0002) via
   * the `@N@` per-index score operator. Two scored fields combined
   * with `math::max(score1, score2)` give us the better of the two
   * — haystack catches predicate-bridge queries (e.g. "complain"
   * matching `complained_about`), object stays for exact-token
   * matches that benefit from a narrower surface (transaction ids,
   * canonical phrases that should not be diluted by predicate
   * tokens).
   */
  private async lexicalLeg(
    db: Surreal,
    query: string,
    k: number,
    baseWhere: { sql: string; params: Record<string, unknown> },
  ): Promise<FactRow[]> {
    // Parens around the OR clause are LOAD-BEARING. SurrealQL
    // evaluates AND with higher precedence than OR (same as SQL),
    // so without them the WHERE parses as
    //   searchHaystack @1@ $q  OR  (object @2@ $q AND <baseWhere>)
    // — meaning a row that matches via the haystack index bypasses
    // EVERY filter in baseWhere (retractedAt IS NONE, status,
    // confidence, asOf, predicates, entityIds). Caught by a
    // memory-lifecycle eval failure where retracted facts surfaced
    // with status='retracted' on a query that hit searchHaystack.
    const sql = `
      SELECT
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity,
        math::max([search::score(1), search::score(2)]) AS bm25Score
      FROM knowledge_fact
      WHERE (searchHaystack @1@ $query OR object @2@ $query)
        ${baseWhere.sql}
      ORDER BY bm25Score DESC
      LIMIT $k
    `;
    try {
      const [rows] = await db.query<[FactRow[]]>(sql, {
        ...baseWhere.params,
        query,
        k,
      });
      return (rows as FactRow[]) ?? [];
    } catch (err) {
      // Fresh tenants without the SEARCH index (e.g. test fixtures
      // pre-dating this migration) shouldn't break free-text search.
      // Fail soft to vector-only by returning [].
      this.logger.warn(`Lexical leg fell back to empty: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * CombMNZ-flavoured score-level convex fusion. Each leg's raw
   * score is normalised to [0, 1] and the legs are combined linearly:
   *
   *   hybrid = (w_v * vec_norm + w_l * lex_norm) * consensus_factor
   *
   * where w_v + w_l = 1 and `consensus_factor = 1.3` if a row
   * surfaced in both legs, 1.0 otherwise. Single-leg presence keeps
   * the row in the candidate set without dominating; both-leg
   * agreement is treated as a cross-distribution signal beyond what
   * either score alone says (CombMNZ, Fox & Shaw 1994).
   */
  private fuse(
    vectorRows: FactRow[],
    lexicalRows: FactRow[],
    mode: SearchMode,
  ): Array<FactRow & { fusedScore: number }> {
    const merged = new Map<string, FactRow & { fusedScore: number }>();

    if (mode === 'vector') {
      vectorRows.forEach((r) => {
        merged.set(String(r.id), {
          ...r,
          fusedScore: this.normalizeVec(r.simScore ?? 0),
        });
      });
      return [...merged.values()];
    }

    if (mode === 'lexical') {
      lexicalRows.forEach((r) => {
        merged.set(String(r.id), {
          ...r,
          fusedScore: this.normalizeLex(r.bm25Score ?? 0),
        });
      });
      return [...merged.values()];
    }

    // Hybrid — convex combination on normalised scores.
    const w_v = HYBRID_VECTOR_WEIGHT;
    const w_l = 1 - HYBRID_VECTOR_WEIGHT;
    vectorRows.forEach((r) => {
      const id = String(r.id);
      const vScore = this.normalizeVec(r.simScore ?? 0);
      merged.set(id, { ...r, fusedScore: w_v * vScore });
    });
    lexicalRows.forEach((r) => {
      const id = String(r.id);
      const lScore = this.normalizeLex(r.bm25Score ?? 0);
      const existing = merged.get(id);
      if (existing) {
        existing.fusedScore += w_l * lScore;
        existing.bm25Score = r.bm25Score;
      } else {
        merged.set(id, { ...r, fusedScore: w_l * lScore });
      }
    });
    return [...merged.values()];
  }

  /**
   * Build the survivor-record map for any merged entities surfaced
   * in the fused result set. Performed in a single batched query so
   * we don't fan out one round trip per loser. Returns a map keyed
   * by survivor record id (string) → its hydrated record.
   *
   * Skipped (returns empty map) when no row has mergedInto set —
   * the steady-state path pays nothing for identity merge support.
   */
  private async hydrateSurvivors(
    db: Surreal,
    rows: FactRow[],
  ): Promise<
    Map<string, { id: unknown; type: string; canonicalName: string; externalRefs?: Record<string, string> }>
  > {
    type Survivor = { id: unknown; type: string; canonicalName: string; externalRefs?: Record<string, string> };
    const survivorIds = new Set<string>();
    for (const r of rows) {
      const m = r.entity?.mergedInto;
      if (m) survivorIds.add(String(m));
    }
    const survivors = new Map<string, Survivor>();
    if (survivorIds.size === 0) return survivors;
    const ids = [...survivorIds].map((s) => new StringRecordId(s));
    const [recs] = await db.query<[Survivor[]]>(
      `SELECT id, type, canonicalName, externalRefs FROM knowledge_entity WHERE id INSIDE $ids`,
      { ids },
    );
    for (const rec of (recs as Survivor[]) ?? []) {
      survivors.set(String(rec.id), rec);
    }
    return survivors;
  }

  /**
   * Re-key any fact whose owner entity has `mergedInto` set onto the
   * survivor — and merge the loser's externalRefs into the survivor's
   * display copy so cross-vertical lookups (e.g. by `events__jonas`)
   * resolve to the same hit. Pure data-shape transform; doesn't touch
   * scores or fact bodies.
   */
  private reattributeMerged(
    rows: Array<FactRow & { fusedScore: number }>,
    survivors: Map<string, { id: unknown; type: string; canonicalName: string; externalRefs?: Record<string, string> }>,
  ): Array<FactRow & { fusedScore: number }> {
    if (survivors.size === 0) return rows;
    const out: Array<FactRow & { fusedScore: number }> = [];
    for (const row of rows) {
      const merged = row.entity?.mergedInto;
      if (!merged) {
        out.push(row);
        continue;
      }
      const survivor = survivors.get(String(merged));
      if (!survivor) {
        // Survivor row missing (shouldn't happen — survivor always
        // exists if mergedInto is set). Drop the loser row from the
        // result set so it doesn't compete with a survivor that
        // would have been promoted into the same slot.
        continue;
      }
      const mergedExternalRefs = {
        ...(survivor.externalRefs ?? {}),
        ...(row.entity?.externalRefs ?? {}),
      };
      out.push({
        ...row,
        entityId: survivor.id,
        entity: {
          id: survivor.id,
          type: survivor.type,
          canonicalName: survivor.canonicalName,
          externalRefs: mergedExternalRefs,
        },
      });
    }
    return out;
  }

  /**
   * Fetch 1-hop neighbours for a set of entity ids in a single
   * batched query. Returns a map keyed by entity id (string) to
   * the list of `(canonicalName, type, kind)` triples — both
   * outgoing and incoming edges, deduped on the (peer, kind) pair.
   *
   * Used to inject SubgraphRAG-style structural context into the
   * reranker prompt. Bounded by the candidate-set size (≤ rerank
   * window, currently 20), so the query is small and runs in a few
   * ms even on dense tenants. Returns an empty map on any failure
   * — the reranker falls back to its non-graph path.
   */
  private async fetchNeighbours(
    db: Surreal,
    entityIds: string[],
  ): Promise<
    Map<
      string,
      Array<{ canonicalName: string; type: string; kind: string }>
    >
  > {
    type Neighbour = {
      canonicalName: string;
      type: string;
      kind: string;
    };
    const out = new Map<string, Neighbour[]>();
    if (entityIds.length === 0) return out;
    const rids = entityIds.map((s) => new StringRecordId(s));
    type Row = {
      id: unknown;
      outNeighbours: Array<{ kind: string; peer: { id: unknown; type: string; canonicalName: string } | null }> | null;
      inNeighbours: Array<{ kind: string; peer: { id: unknown; type: string; canonicalName: string } | null }> | null;
    };
    try {
      const [rows] = await db.query<[Row[]]>(
        `SELECT
           id,
           ->knowledge_edge.{ kind, peer: out.{id, type, canonicalName} } AS outNeighbours,
           <-knowledge_edge.{ kind, peer: in.{id, type, canonicalName} } AS inNeighbours
         FROM $ids`,
        { ids: rids },
      );
      for (const row of (rows as Row[]) ?? []) {
        const id = String(row.id);
        const list: Neighbour[] = [];
        const seen = new Set<string>();
        const pushSide = (
          side: Array<{ kind: string; peer: { id: unknown; type: string; canonicalName: string } | null }> | null,
        ) => {
          if (!side) return;
          for (const e of side) {
            if (!e?.peer) continue;
            const peerId = String(e.peer.id);
            // Self-loop guard (identity_of after merge): skip when
            // the peer is the entity itself.
            if (peerId === id) continue;
            const key = `${peerId}|${e.kind}`;
            if (seen.has(key)) continue;
            seen.add(key);
            list.push({
              canonicalName: e.peer.canonicalName,
              type: e.peer.type,
              kind: e.kind,
            });
          }
        };
        pushSide(row.outNeighbours);
        pushSide(row.inNeighbours);
        out.set(id, list);
      }
    } catch (err) {
      this.logger.warn(
        `fetchNeighbours failed, reranker falls back without graph context: ${(err as Error).message}`,
      );
    }
    return out;
  }

  /**
   * Personalized PageRank prior over the candidate-entity subgraph.
   * Mutates `byEntity[*].rankScore` in place. Algorithm:
   *
   *   1. Fetch every edge whose endpoints are both in the candidate
   *      set — small subgraph, single query.
   *   2. Seed each candidate with its bestScore (then row-normalise).
   *   3. Run 3 power iterations of  r ← α · M · r + (1−α) · seed
   *      with α=0.85 (textbook PageRank damping).
   *   4. Multiply rankScore by (1 + β · r) where β bounds the
   *      cluster lift. β=0.5 → up to 1.5× boost for the top-prior
   *      entity, 1.0× for an isolated candidate.
   *
   * Edge weights honour the `weight` column on knowledge_edge.
   * Identity_of edges (loser→survivor) are intentionally
   * symmetric-weighted because the merge has already happened in
   * `reattributeMerged`; here they just reinforce their cluster.
   *
   * Returns silently when there are no edges in the subgraph — PPR
   * with no transitions reduces to the identity (seed in, seed out).
   */
  private async applyPprPrior(
    db: Surreal,
    byEntity: Map<
      string,
      { entityId: string; rankScore: number; bestScore: number; facts: any[] }
    >,
  ): Promise<void> {
    const ids = [...byEntity.keys()];
    if (ids.length < 2) return;
    const ridIds = ids.map((s) => new StringRecordId(s));

    type EdgeRow = { in: unknown; out: unknown; weight?: number };
    const [edgeRows] = await db.query<[EdgeRow[]]>(
      `SELECT in, out, weight FROM knowledge_edge
       WHERE in INSIDE $ids AND out INSIDE $ids`,
      { ids: ridIds },
    );
    const edges = (edgeRows as EdgeRow[]) ?? [];
    if (edges.length === 0) return;

    // Build adjacency. Treat as undirected — the relations we care
    // about (mentioned_with, identity_of) are symmetric in
    // disambiguation semantics, even when stored directionally.
    const adj = new Map<string, Array<{ to: string; w: number }>>();
    for (const id of ids) adj.set(id, []);
    for (const e of edges) {
      const a = String(e.in);
      const b = String(e.out);
      const w = typeof e.weight === 'number' ? e.weight : 1.0;
      if (adj.has(a) && adj.has(b)) {
        adj.get(a)!.push({ to: b, w });
        adj.get(b)!.push({ to: a, w });
      }
    }

    // Out-weight per node for normalised flow.
    const outWeight = new Map<string, number>();
    for (const [src, nbrs] of adj) {
      outWeight.set(src, nbrs.reduce((acc, n) => acc + n.w, 0));
    }

    // Seed: bestScore-weighted, row-normalised so seed mass = 1.
    const seedRaw = new Map<string, number>();
    let seedSum = 0;
    for (const [id, b] of byEntity) {
      const s = Math.max(b.bestScore, 0);
      seedRaw.set(id, s);
      seedSum += s;
    }
    if (seedSum === 0) return;
    const seed = new Map<string, number>();
    for (const [id, s] of seedRaw) seed.set(id, s / seedSum);

    let r = new Map(seed);
    const ALPHA = 0.85;
    const ITERATIONS = 3;
    for (let i = 0; i < ITERATIONS; i++) {
      const next = new Map<string, number>();
      for (const id of ids) next.set(id, (1 - ALPHA) * (seed.get(id) ?? 0));
      for (const [src, mass] of r) {
        const ow = outWeight.get(src) ?? 0;
        if (ow === 0) {
          // Dangling node — distribute its mass back uniformly to
          // its own seed slot so we don't lose probability mass.
          next.set(src, (next.get(src) ?? 0) + ALPHA * mass);
          continue;
        }
        for (const nbr of adj.get(src) ?? []) {
          const flow = ALPHA * mass * (nbr.w / ow);
          next.set(nbr.to, (next.get(nbr.to) ?? 0) + flow);
        }
      }
      r = next;
    }

    // Multiply rankScore by (1 + β·r). Normalise r by its max so
    // the top entity gets the full boost regardless of absolute scale.
    const PPR_BOOST_BETA = 0.5;
    let maxR = 0;
    for (const v of r.values()) if (v > maxR) maxR = v;
    if (maxR === 0) return;
    for (const [id, bucket] of byEntity) {
      const rNorm = (r.get(id) ?? 0) / maxR;
      bucket.rankScore = bucket.rankScore * (1 + PPR_BOOST_BETA * rNorm);
    }
  }

  /** Cosine in [-1, 1] → [0, 1] with negative-correlation clamped to 0. */
  private normalizeVec(s: number): number {
    return s <= 0 ? 0 : s > 1 ? 1 : s;
  }

  /**
   * Squash BM25 scores into [0, 1] via a saturation curve. BM25 is
   * unbounded (a 5-term match on a short doc can score 10+), so we
   * pass it through x/(1+x) to keep the lexical-only mode's final
   * score on the same scale as vector cosine.
   */
  private normalizeLex(s: number): number {
    return s <= 0 ? 0 : s / (1 + s);
  }

  private buildBaseWhere(
    dto: SearchDto,
    asOf: Date | null,
    includeRetracted: boolean,
    includeContested: boolean,
  ): { sql: string; params: Record<string, unknown> } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (!includeRetracted) clauses.push(`AND retractedAt IS NONE`);
    if (!includeContested) clauses.push(`AND status != 'competing'`);
    if (dto.minConfidence !== undefined) {
      clauses.push(`AND confidence >= $minConfidence`);
      params.minConfidence = dto.minConfidence;
    }
    if (dto.predicates && dto.predicates.length > 0) {
      clauses.push(`AND predicate INSIDE $predicates`);
      params.predicates = dto.predicates;
    }
    if (dto.entityIds && dto.entityIds.length > 0) {
      // Multi-hop anchoring. Accept both short and fully-qualified
      // ids; SurrealDB record-link parsing tolerates both via the
      // `type::thing` cast at query time.
      clauses.push(`AND entityId INSIDE $entityIds`);
      params.entityIds = dto.entityIds.map((raw) => {
        const id = raw.startsWith('knowledge_entity:')
          ? raw.slice('knowledge_entity:'.length)
          : raw;
        return new StringRecordId(`knowledge_entity:${id}`);
      });
    }
    if (asOf) {
      // Search asOf = "what was factually true at that date".
      // Filter on the validity axis (validFrom/validUntil) only;
      // do NOT gate on recordedAt — search shouldn't disappear a
      // fact just because brain learned it after the asOf cutoff
      // (e.g. a tier change reported in May about a January state).
      // The retractedAt guard stays: a fact retracted before asOf
      // wasn't true at that date.
      //
      // Knowledge-axis "as we knew it on date X" semantics live on
      // the entity-timeline endpoint (entities.service.ts), which
      // does gate on recordedAt — that's the audit shape.
      clauses.push(
        `AND (retractedAt IS NONE OR retractedAt > $asOf)
         AND validFrom <= $asOf
         AND (validUntil IS NONE OR validUntil > $asOf)`,
      );
      params.asOf = asOf;
    }

    return { sql: clauses.join('\n        '), params };
  }

  private passesPolicy(row: FactRow, dto: SearchDto, callerScopes: string[]): boolean {
    const policy = policyFor(row.predicate);
    if (policy.requiresScope && !callerScopes.includes(policy.requiresScope)) {
      return false;
    }
    return true;
  }
}
