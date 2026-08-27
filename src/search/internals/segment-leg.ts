import type { Surreal } from 'surrealdb';
import { segmentUserGate } from '../../auth/segment-scope';
import type { FactRow } from './types';

/**
 * Verbatim fusion leg (audit W4 #18): episode_segment rows retrieved as
 * first-class retrieval candidates when the profile says
 * verbatimEvidence='fused'. Until this leg, L0 reached answers only as
 * a prompt appendix — quotes never entered SearchHit, never got scored
 * or reranked against facts, and were structurally uncitable ("cite
 * factIds only").
 *
 * Each segment becomes a pseudo-FactRow whose bucket is itself:
 *  - id/entityId    — the segment record id (so a citation
 *                     [episode_segment:…] resolves through the same
 *                     fact-index machinery as [knowledge_fact:…]);
 *  - predicate      — 'verbatim';
 *  - object         — the rendered multi-turn window text;
 *  - validFrom      — the window's occurredAt (temporal semantics —
 *                     the overlap boost and asOf reasoning see it);
 *  - recordedAt     — the query instant, deliberately: verbatim
 *                     substrate must not rot under the generic 60-day
 *                     read-decay the way derived facts do (the appendix
 *                     lane it replaces had no decay at all);
 *  - confidence 1   — a verbatim record is not an extraction guess.
 *
 * Both queries reuse the appendix lane's exact idioms (cosine scan +
 * BM25 `@1@`, PII fence, fail-closed user scope) so the leg retrieves
 * the same pool the measured segment lane did — the difference is what
 * happens downstream: convex fusion + scoring + rerank + fact-centric
 * arbitration instead of a blind prompt append.
 */
export interface SegmentLegOptions {
  db: Pick<Surreal, 'query'>;
  queryText: string;
  queryVector: number[] | null;
  /** Candidates per leg (the lane idiom: max(topK*3, 12)). */
  fetchK: number;
  callerScopes: string[];
  userId?: string | undefined;
  mode: 'hybrid' | 'vector' | 'lexical';
}

interface SegmentRow {
  id: unknown;
  conversationId?: string;
  text: string;
  occurredAt: unknown;
  score?: number;
}

/**
 * Per-segment prompt budget (V6 finding, validate-2026-08-results):
 * fused with segmentTopK=5 still ran 8.6k prompt tokens on SSA and
 * 12.4k on TR vs ~4.6k control, because whole 4-turn windows ride into
 * the prompt. The budget truncates the segment TEXT at a word boundary
 * — retrieval is untouched (cosine runs on stored vectors, BM25 on the
 * indexed column), only what enters scoring text/prompt/citation is
 * cut. ~1200 chars ≈ 300 tokens ≈ 5 segments ≈ +1.5k over control.
 * Tuning constant by design (brief §3: prefer a constant over a knob).
 */
const SEGMENT_PROMPT_CHAR_BUDGET = 1200;

function budgetText(text: string): string {
  if (text.length <= SEGMENT_PROMPT_CHAR_BUDGET) return text;
  const cut = text.slice(0, SEGMENT_PROMPT_CHAR_BUDGET);
  const atWord = cut.slice(0, cut.lastIndexOf(' ') + 1 || undefined);
  return `${atWord.trimEnd()} […]`;
}

function toFactRow(r: SegmentRow, kind: 'vector' | 'lexical'): FactRow {
  const occurred = String(r.occurredAt ?? '');
  const day = occurred.slice(0, 10);
  return {
    id: r.id,
    entityId: r.id,
    predicate: 'verbatim',
    object: budgetText(r.text),
    confidence: 1,
    validFrom: occurred,
    recordedAt: new Date().toISOString(),
    status: 'active',
    source: {
      vertical: 'segment',
      ...(r.conversationId ? { conversationId: r.conversationId } : {}),
    },
    entity: {
      id: r.id,
      type: 'segment',
      canonicalName: r.conversationId
        ? `conversation ${r.conversationId}${day ? ` (${day})` : ''}`
        : `transcript segment${day ? ` (${day})` : ''}`,
      externalRefs: {},
    },
    ...(kind === 'vector' ? { simScore: r.score ?? 0 } : { bm25Score: r.score ?? 0 }),
  };
}

/**
 * Run the two segment queries per the search mode. Returns
 * (vectorRows, lexicalRows) shaped as pseudo-FactRows, ready for the
 * SAME convex fuse() the fact legs use — one fusion doctrine, not two
 * (audit #21: the appendix lane ran its own RRF).
 */
export async function runSegmentLegs({
  db,
  queryText,
  queryVector,
  fetchK,
  callerScopes,
  userId,
  mode,
}: SegmentLegOptions): Promise<{
  vectorRows: FactRow[];
  lexicalRows: FactRow[];
}> {
  const piiGate = callerScopes.includes('brain:read_pii') ? '' : 'AND piiClass IS NONE';
  // Fail-closed user scope (0055 + 0117, PRIVACY_SEGMENT_USER_FENCE):
  // an unscoped read stays tenant-global; with the fence on, a
  // mixed-user window is served only to its own members
  // (segmentUserGate — the shared gate of all four segment seams).
  const gate = segmentUserGate(userId);

  const [denseRes, bm25Res] = await Promise.all([
    mode !== 'lexical' && queryVector
      ? db.query<[SegmentRow[]]>(
          `SELECT id, conversationId, text, occurredAt,
                  vector::similarity::cosine(embedding, $q) AS score
             FROM episode_segment
            WHERE embedding != NONE ${piiGate} ${gate.clause}
            ORDER BY score DESC
            LIMIT $k`,
          { q: queryVector, k: fetchK, ...gate.params },
        )
      : Promise.resolve([[] as SegmentRow[]]),
    mode !== 'vector'
      ? db.query<[SegmentRow[]]>(
          `SELECT id, conversationId, text, occurredAt,
                  search::score(1) AS score
             FROM episode_segment
            WHERE text @1@ $q ${piiGate} ${gate.clause}
            ORDER BY score DESC
            LIMIT $k`,
          { q: queryText, k: fetchK, ...gate.params },
        )
      : Promise.resolve([[] as SegmentRow[]]),
  ]);
  return {
    vectorRows: (denseRes[0] ?? []).map((r) => toFactRow(r, 'vector')),
    lexicalRows: (bm25Res[0] ?? []).map((r) => toFactRow(r, 'lexical')),
  };
}
