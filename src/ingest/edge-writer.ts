import { Surreal, StringRecordId } from 'surrealdb';
import { isUniqueViolation, queryFirst } from '../db/surreal.service';

/** `knowledge_edge` row projection — the id, plus the period on a UNIQUE hit. */
interface EdgeIdRow {
  id: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
}

/**
 * The scope half of an edge's identity, as the row computes it
 * (0153: `scopeKey = userId ?? ''`). Lookups key on it so a personal
 * edge and the tenant-global edge of the same triple are two rows.
 */
export function edgeScopeKey(userId: string | undefined): string {
  return userId ?? '';
}

export interface EdgeWrite {
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  source: Record<string, unknown>;
  weight?: number;
  /** Per-user scope (0055): the edge belongs to this user's memory. */
  userId?: string | undefined;
  /** Valid time (0164): when the relation began to hold. Absent = unknown start. */
  validFrom?: Date | undefined;
  /** Valid time (0164): when it stopped holding. Absent = still holds. */
  validUntil?: Date | undefined;
}

/**
 * The valid-time half of a RELATE CONTENT, as extra `key: $param`
 * fields plus their binds. Keys are OMITTED when unknown: the columns are
 * option<datetime>, which reject NULL, and an absent key is the NONE the
 * row means by "open on that side".
 *
 * A relation whose end is already past is written closed on the
 * knowledge axis too (invalidatedAt = now, the current-state fence every
 * read without `asOf` runs behind) — otherwise "until the 24th brain ran
 * on A", learned on the 25th, would read as the current graph. A future
 * end still holds today and stays open.
 *
 * `suffix` keeps the bind names unique in a multi-statement batch.
 */
export function edgeTimeContent(
  t: { validFrom?: Date | undefined; validUntil?: Date | undefined },
  suffix = '',
  now: Date = new Date(),
): { fields: string; params: Record<string, Date> } {
  const params: Record<string, Date> = {};
  const fields: string[] = [];
  if (t.validFrom) {
    params[`validFrom${suffix}`] = t.validFrom;
    fields.push(`validFrom: $validFrom${suffix}`);
  }
  if (t.validUntil) {
    params[`validUntil${suffix}`] = t.validUntil;
    fields.push(`validUntil: $validUntil${suffix}`);
    if (t.validUntil.getTime() <= now.getTime()) {
      params[`invalidatedAt${suffix}`] = now;
      fields.push(`invalidatedAt: $invalidatedAt${suffix}`);
    }
  }
  return { fields: fields.map((f) => `, ${f}`).join(''), params };
}

/**
 * Fold a re-stated relation's period into the edge that already holds
 * the triple (the UNIQUE hit): a statement placing the start EARLIER
 * than recorded moves it back, and an end the row lacks closes it —
 * with the same knowledge-time close as a fresh write. Never the other
 * way: a later start or a missing end says nothing about the stored
 * period, and a closed relation is not reopened to NONE by a statement
 * that simply omits the end. An unknown stored start (NONE) is already
 * the earliest there is.
 */
/**
 * Would folding `t` into a stored period change it? Read JS-side so a
 * re-ingest that restates what the row already holds costs no write
 * (the batched mention path keeps its one round-trip).
 */
export function edgeTimingWidens(
  stored: { validFrom?: unknown; validUntil?: unknown },
  t: { validFrom?: Date | undefined; validUntil?: Date | undefined },
): boolean {
  const storedFrom = asMs(stored.validFrom);
  if (t.validFrom && storedFrom !== undefined && t.validFrom.getTime() < storedFrom) return true;
  return !!t.validUntil && asMs(stored.validUntil) === undefined;
}

function asMs(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const ms = new Date(v as string | Date).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export async function widenEdgeTiming(
  db: Surreal,
  edgeId: string,
  t: { validFrom?: Date | undefined; validUntil?: Date | undefined },
): Promise<void> {
  const w = edgeWidenStatements(edgeId, t);
  if (w.stmts.length > 0) await db.query(w.stmts.join('\n'), w.params);
}

/**
 * The statements behind widenEdgeTiming, for a caller that folds many
 * edges in one round-trip (the batched mention path). `suffix` keeps the
 * bind names unique across edges.
 */
export function edgeWidenStatements(
  edgeId: string,
  t: { validFrom?: Date | undefined; validUntil?: Date | undefined },
  { suffix = '', now = new Date() }: { suffix?: string; now?: Date } = {},
): { stmts: string[]; params: Record<string, unknown> } {
  const id = `$id${suffix}`;
  const from = `$validFrom${suffix}`;
  const until = `$validUntil${suffix}`;
  const stmts: string[] = [];
  const params: Record<string, unknown> = {};
  if (!t.validFrom && !t.validUntil) return { stmts, params };
  params[`id${suffix}`] = new StringRecordId(edgeId);
  if (t.validFrom) {
    params[`validFrom${suffix}`] = t.validFrom;
    stmts.push(
      `UPDATE ${id} SET validFrom = ${from} WHERE validFrom IS NOT NONE AND validFrom > ${from};`,
    );
  }
  if (t.validUntil) {
    params[`validUntil${suffix}`] = t.validUntil;
    const close = t.validUntil.getTime() <= now.getTime();
    if (close) params[`now${suffix}`] = now;
    const closeKnowledge = close ? `, invalidatedAt = invalidatedAt ?? $now${suffix}` : '';
    // A start at or after the new end was the write stamp of a relation
    // that in fact ended — unknown start, as in the supersession close.
    stmts.push(
      `UPDATE ${id} SET validUntil = ${until}, ` +
        `validFrom = IF validFrom != NONE AND validFrom < ${until} THEN validFrom ELSE NONE END` +
        closeKnowledge +
        ' WHERE validUntil IS NONE;',
    );
  }
  return { stmts, params };
}

/**
 * Create a knowledge_edge between two ALREADY-resolved entity IDs.
 * Idempotent within a scope: UNIQUE on (in, out, kind, scopeKey) —
 * concurrent / duplicate RELATEs return the existing edge id.
 *
 * The ONE edge-write primitive: the mention path, the document commit
 * path and the link API all write through it, so the scope stamp and
 * the idempotency rule cannot drift between copies.
 */
export async function createEdgeBetween(db: Surreal, p: EdgeWrite): Promise<string | null> {
  const fromRid = new StringRecordId(p.fromEntityId);
  const toRid = new StringRecordId(p.toEntityId);
  const time = edgeTimeContent(p);
  try {
    const edge = await queryFirst<EdgeIdRow>(
      db,
      `RELATE $from->knowledge_edge->$to CONTENT { kind: $kind, weight: $weight, source: $source, userId: $userId${time.fields} } RETURN AFTER`,
      {
        from: fromRid,
        to: toRid,
        kind: p.kind,
        weight: p.weight ?? 1.0,
        source: p.source,
        userId: p.userId,
        ...time.params,
      },
    );
    return edge ? String(edge.id) : null;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await queryFirst<EdgeIdRow>(
      db,
      `SELECT id, validFrom, validUntil FROM knowledge_edge WHERE in = $from AND out = $to AND kind = $kind AND scopeKey = $scopeKey LIMIT 1`,
      { from: fromRid, to: toRid, kind: p.kind, scopeKey: edgeScopeKey(p.userId) },
    );
    if (!existing) return null;
    const id = String(existing.id);
    if (edgeTimingWidens(existing, p)) await widenEdgeTiming(db, id, p);
    return id;
  }
}
