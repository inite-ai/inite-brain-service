import { StringRecordId, type Surreal } from 'surrealdb';
import { buildEdgeFence } from './edge-fence';
import { buildLexMatchLeg } from './lex-leg';
import type { FactRow } from './types';

/**
 * Relation leg: the graph's edges as retrieval candidates in their own
 * right, beside the fact legs.
 *
 * A relation used to reach the answer plane only as an attachment to a
 * fact hit (`relations` on the hit). An entity with no fact that held at
 * the asked time therefore took its relations with it: "на какой модели
 * работал движок brain 20 сентября?" found no hit at all, although the
 * edge "brain — runs_on → gpt-5.6-luna (until 2026-09-24)" answered it
 * — every fact about brain came from a document written on the 24th.
 *
 * The entities the question names (recall-first BM25 over their names,
 * any word of the question — lex-leg.ts) bring the edges they are the
 * subject of (the row reads in the edge's direction) that hold at
 * the asked time (edge-fence.ts: valid time under asOf, the current
 * graph otherwise). Each edge becomes a fact-shaped row keyed by the
 * edge record — subject = the edge's `in`, predicate = its kind, value =
 * the peer's name, validity = the edge's own — so it is scored, fused,
 * ranked and cited exactly like a fact, and the citation names the edge
 * (fact-index isEdgeCitation). Fenced like every edge walk: tenant scope
 * plus the caller's own, on the edge and on both endpoints.
 */
const NAMED_ENTITY_CAP = 8;
/** Relations one named entity brings — an entity with no fact at T is
 *  answered by its few relations, not by its whole neighbourhood. */
const EDGES_PER_ENTITY = 8;

interface EdgeHit {
  id: unknown;
  kind: string;
  validFrom?: unknown;
  validUntil?: unknown;
  weight?: number | null;
  source?: Record<string, unknown> | null;
  userId?: string | null;
  fromE: EndpointRow | null;
  toE: EndpointRow | null;
}

interface EndpointRow {
  id: unknown;
  type: string;
  canonicalName: string;
  externalRefs?: Record<string, string> | null;
  userId?: string | null;
}

export async function runRelationLeg(opts: {
  db: Surreal;
  queryText: string;
  userId?: string | undefined;
  asOf?: string | undefined;
  fetchK: number;
}): Promise<FactRow[]> {
  const { db, queryText, userId, asOf, fetchK } = opts;
  const lex = buildLexMatchLeg({ fields: ['canonicalName'], topic: queryText, mode: 'or_terms' });
  const entityScope = userId ? '(userId IS NONE OR userId = $u)' : 'userId IS NONE';
  const [named] = await db.query<[Array<{ id: unknown; score: number }>]>(
    `SELECT id, ${lex.score} AS score FROM knowledge_entity
      WHERE ${lex.where} AND mergedInto IS NONE AND ${entityScope}
      ORDER BY score DESC LIMIT $n`,
    { ...lex.params, u: userId, n: NAMED_ENTITY_CAP },
  );
  const nameScore = new Map((named ?? []).map((r) => [String(r.id), r.score ?? 0]));
  if (nameScore.size === 0) return [];
  const fence = buildEdgeFence(userId, asOf);
  const ids = [...nameScore.keys()].map((id) => new StringRecordId(id));
  const endpoint = '{ id, type, canonicalName, externalRefs, userId }';
  const [edges] = await db.query<[EdgeHit[]]>(
    `SELECT id, kind, validFrom, validUntil, weight, source, userId,
            in.${endpoint} AS fromE, out.${endpoint} AS toE
       FROM knowledge_edge
      WHERE in INSIDE $ids AND ${fence.cond}
      LIMIT $k`,
    { ids, k: fetchK, ...fence.params },
  );
  const rows: FactRow[] = [];
  const perSubject = new Map<string, number>();
  for (const e of edges ?? []) {
    const { fromE, toE } = e;
    if (!fromE || !toE) continue;
    if (!fence.allowsPeer(fromE.userId) || !fence.allowsPeer(toE.userId)) continue;
    const subject = String(fromE.id);
    const n = perSubject.get(subject) ?? 0;
    if (n >= EDGES_PER_ENTITY) continue;
    perSubject.set(subject, n + 1);
    rows.push(edgeRow(e, fromE, toE, nameScore.get(subject) ?? 0));
  }
  return rows;
}

/** One edge as a fact-shaped row of its subject entity. */
// eslint-disable-next-line max-params
function edgeRow(e: EdgeHit, from: EndpointRow, to: EndpointRow, score: number): FactRow {
  const confidence =
    typeof e.source?.confidence === 'number' ? e.source.confidence : (e.weight ?? 0.9);
  const validUntil = iso(e.validUntil);
  return {
    id: e.id,
    entityId: from.id,
    predicate: e.kind,
    object: to.canonicalName,
    confidence,
    // '' = began before anything recorded says (0164): neutral in
    // scoring, no "as of" in the rendered line.
    validFrom: iso(e.validFrom) ?? '',
    ...(validUntil ? { validUntil } : {}),
    recordedAt: new Date().toISOString(),
    status: 'active',
    source: e.source ?? null,
    userId: e.userId ?? null,
    entity: {
      id: from.id,
      type: from.type,
      canonicalName: from.canonicalName,
      externalRefs: from.externalRefs ?? {},
    },
    bm25Score: score,
  };
}

function iso(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const d =
    v instanceof Date
      ? v
      : typeof (v as { toDate?: unknown }).toDate === 'function'
        ? (v as { toDate: () => Date }).toDate()
        : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
