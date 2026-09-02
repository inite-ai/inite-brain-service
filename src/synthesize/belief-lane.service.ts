import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { beliefVisible } from '../beliefs/beliefs.service';
import { rrfFuse } from './segment-lane.service';
import { buildLexMatchLeg } from './lex-leg';
import type { CitableBelief } from './belief-citations';

/** Belief lines per prompt (design constant, BELIEFS_SERVING_LANE —
 *  deliberately NOT an env knob until the lane is measured; the
 *  FRAGMENT_LANE_TOP_K idiom). */
const BELIEF_LANE_TOP_K = 3;
/** Rendered statement cap per line (the 600-char line-cap idiom). */
const BELIEF_EXCERPT_MAX_CHARS = 600;

/** semantic_belief row columns the lane selects. */
interface BeliefLaneRow {
  id: unknown;
  userId?: unknown;
  subject?: unknown;
  field?: unknown;
  value?: unknown;
  statement?: unknown;
  revision?: unknown;
  validFrom?: Date | string;
  score?: number;
}

/** The lane's output: rendered lines + the rendered-set citation fence. */
export interface BeliefLaneResult {
  /** One line per (subject, field), validFrom-ascending, headed by the
   *  `[semantic_belief:...]` id (citations ride the master flag). */
  lines: string[];
  /**
   * beliefId → rendered-belief info for resolveBeliefCitations —
   * EXACTLY the beliefs rendered into `lines` (the l3-citations
   * turnsById fence). Empty ⟺ `lines` is empty.
   */
  byId: Map<string, CitableBelief>;
}

const EMPTY_RESULT: BeliefLaneResult = { lines: [], byId: new Map() };

/**
 * Belief retrieval lane (BELIEFS_SERVING_LANE) — the first serving
 * surface of the 0120 belief substrate. This lane REPEALS the 0120
 * shadow doctrine ("nothing on the serving path reads this table")
 * behind the default-off master flag.
 *
 * Retrieves ACTIVE semantic_belief rows on their own BM25+dense merit —
 * the fragment-lane shape: two legs fused by reciprocal rank. The
 * lexical leg rides the 0126 lowercase FULLTEXT index over `statement`
 * (the deterministic template embeds subject, field, value and prior
 * value, so one index covers the whole key) — composed as the V11 A2
 * `or_terms` disjunction (buildLexMatchLeg): the matches operator is
 * AND-semantics over analyzed tokens, so a phrase-shaped `@1@ $query`
 * leg would require the WHOLE question to appear in a short statement
 * and (with dense write-dead) leave the lane empty for every natural
 * question; the bounded per-term disjunction makes a belief mentioning
 * ANY informative query word a lexical hit, ranked by summed BM25. The
 * dense leg is a brute cosine over semantic_belief.embedding, which is
 * WRITE-DEAD in v1 (no producer fills it — 0126 header), so it degrades
 * to empty by construction until a producer exists; an embedder failure
 * is caught per-leg and never kills the lexical leg.
 *
 * FENCE ORDER (composed per read):
 *   1. tenant  — SurrealService.withCompany scoping;
 *   2. user    — SCOPED-USER-ONLY, fail-closed (D4): `userId ===
 *      undefined` ⇒ the lane is EMPTY, no query issued. DELIBERATE
 *      TIGHTENING vs GET /v1/beliefs, where an M2M credential reads the
 *      whole tenant: an explicit admin/API read is auditable, but
 *      silently blending user A's current-state into an unscoped agent
 *      ANSWER is a cross-user leak no serving lane allows — and no
 *      belief is tenant-global (0120 userId TYPE string, never NONE),
 *      so the platform-wide 0055 unscoped-serves-global rule yields
 *      nothing here anyway. Scoped: SQL `userId = $u` (index-backed
 *      belief_user_idx; WHERE on a secondary index is safe for SELECT —
 *      only DELETE hits the 3.2.4 planner no-op);
 *   3. status  — only `status = 'active'` rows ever serve (current
 *      state by construction; the supersede chain guarantees one active
 *      row per (userId, subject, field));
 *   4. JS re-check — beliefVisible(row, userId) fail-closed (the
 *      read-API doctrine: a blank/missing stamp is visible to NO ONE);
 *   5. dedupe by (subject, field) keeping the best-fused row, cap at
 *      BELIEF_LANE_TOP_K, sort by validFrom ascending;
 *   6. any error degrades to an empty section, never fails the answer.
 *
 * Same contracts as the sibling lanes: activation comes from the
 * caller-resolved flag (beliefServingLaneEnabled(), resolved ONCE per
 * request by the orchestrator) — this service reads no env.
 */
@Injectable()
export class BeliefLaneService {
  private readonly logger = new Logger(BeliefLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async beliefLines(opts: {
    companyId: string;
    query: string;
    /** Scope key of the asking end-user; omitted → the lane is EMPTY
     *  (fence 2 — scoped-user-only, see the class doc). */
    userId?: string | undefined;
  }): Promise<BeliefLaneResult> {
    // Fence 2 (D4): an unscoped request serves NO beliefs — checked
    // before any IO so the off-path issues zero queries.
    if (opts.userId === undefined) return EMPTY_RESULT;
    const userId = opts.userId;
    const fetchK = Math.max(BELIEF_LANE_TOP_K * 3, 9);
    try {
      // Dense leg's query vector — its own degrade: an embedder failure
      // must not kill the lexical leg.
      let queryVector: number[] | null = null;
      try {
        queryVector = await this.embedder.embed(opts.query);
      } catch (e) {
        this.logger.warn(`belief lane dense leg unavailable: ${(e as Error).message}`);
      }

      // Fences 2/3 compose in the WHERE, in the design order.
      const where = `userId = $u AND status = 'active'`;
      const select = `id, userId, subject, field, value, statement, revision, validFrom`;
      const fused = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [dense] = queryVector
          ? await db.query<[BeliefLaneRow[]]>(
              `SELECT ${select},
                    vector::similarity::cosine(embedding, $q) AS score
               FROM semantic_belief
              WHERE embedding != NONE AND ${where}
              ORDER BY score DESC
              LIMIT $k`,
              { q: queryVector, k: fetchK, u: userId },
            )
          : [[] as BeliefLaneRow[]];
        // The or_terms disjunctive BM25 leg (see the class doc) —
        // composed per request over the caller's query text.
        const lex = buildLexMatchLeg({
          fields: ['statement'],
          topic: opts.query,
          mode: 'or_terms',
        });
        const [bm25] = await db.query<[BeliefLaneRow[]]>(
          `SELECT ${select}, ${lex.score} AS score
               FROM semantic_belief
              WHERE ${lex.where} AND ${where}
              ORDER BY score DESC
              LIMIT $k`,
          { ...lex.params, k: fetchK, u: userId },
        );
        return rrfFuse([dense ?? [], bm25 ?? []]);
      });
      if (fused.length === 0) return EMPTY_RESULT;
      return this.render(fused, userId);
    } catch (e) {
      // Fence 6: degrade to an empty section, never fail the answer.
      this.logger.warn(`belief lane failed (companyId=${opts.companyId}): ${(e as Error).message}`);
      return EMPTY_RESULT;
    }
  }

  /**
   * One line per (subject, field) key (the best-fused revision wins —
   * with the supersede chain there is at most one active row per key,
   * so this is defense in depth), validFrom-ascending, capped at
   * BELIEF_LANE_TOP_K. Line shape:
   *   `[semantic_belief:...] (<subject> — <field>, rev <revision>, as of <day>) <statement>`
   * The id header renders UNCONDITIONALLY — belief citations ride the
   * master flag (no separate switch; see belief-citations.ts). Fence 4
   * (beliefVisible) re-applies here fail-closed: an out-of-contract row
   * the SQL fence let through never renders.
   */
  private render(fused: BeliefLaneRow[], userId: string): BeliefLaneResult {
    const byKey = new Map<string, BeliefLaneRow>();
    for (const row of fused) {
      // Fence 4: JS re-check of the user fence (the read-API doctrine).
      if (!beliefVisible(row, userId)) continue;
      const beliefId = row.id === undefined ? '' : String(row.id);
      const statement = typeof row.statement === 'string' ? row.statement : '';
      if (!beliefId || !statement.trim()) continue;
      const key = `${String(row.subject ?? '')}|${String(row.field ?? '')}`;
      if (!byKey.has(key)) byKey.set(key, row);
      if (byKey.size >= BELIEF_LANE_TOP_K) break;
    }
    const kept = [...byKey.values()].sort((a, b) => toMs(a.validFrom) - toMs(b.validFrom));
    const lines: string[] = [];
    const byId = new Map<string, CitableBelief>();
    for (const row of kept) {
      const beliefId = String(row.id);
      const excerpt = String(row.statement).slice(0, BELIEF_EXCERPT_MAX_CHARS);
      const day = isoDay(row.validFrom);
      lines.push(
        `[${beliefId}] (${String(row.subject ?? '')} — ${String(row.field ?? '')}, ` +
          `rev ${String(row.revision ?? 1)}${day ? `, as of ${day}` : ''}) ${excerpt}`,
      );
      byId.set(beliefId, {
        beliefId,
        subject: String(row.subject ?? ''),
        field: String(row.field ?? ''),
        value: String(row.value ?? ''),
        excerpt,
        ...(day ? { occurredAt: isoInstant(row.validFrom) } : {}),
      });
    }
    return { lines, byId };
  }
}

function toMs(v: Date | string | undefined): number {
  if (v === undefined) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

function isoDay(v: Date | string | undefined): string {
  if (v === undefined) return '';
  const ms = toMs(v);
  return ms === 0 ? '' : new Date(ms).toISOString().slice(0, 10);
}

function isoInstant(v: Date | string | undefined): string {
  return new Date(toMs(v)).toISOString();
}
