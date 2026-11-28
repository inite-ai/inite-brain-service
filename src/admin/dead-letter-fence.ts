import { StringRecordId, type Surreal } from 'surrealdb';
import { pinUserScope } from '../auth/user-scope';
import type { PredicateRegistryService } from '../ai/predicate-registry.service';
import { makeRowPolicyFilter, type RowPolicyFilter } from '../policy/row-filter';

/**
 * Read fences for `ingest_dead_letter` rows on the operator surfaces
 * (GET /v1/admin/dlq, the overview's recent list).
 *
 * A dead letter keeps the refused claim in `payload` —
 * `{ entityId, predicate, object, source }` — so it is memory content,
 * and brain:admin alone never widened what a key may read: before this,
 * the DLQ showed the value of a brain:read_pii predicate to a key without
 * that scope, and one end user's refused facts to another user's key.
 *
 * The payload has no `userId` (fn::resolve_fact writes none), so the
 * owner is resolved the way the user-forget cascade resolves it
 * (user-forget.service eraseDeadLetters): the user of the entity the
 * claim names, else the user of the document it came from. A claim from
 * a tenant-global document is tenant-global; anything else is unknown.
 *
 *   - User-bound caller (a token acting for one end user): a row is shown
 *     only when it is provably that user's or tenant-global. Another
 *     user's rows and rows whose owner cannot be determined are absent
 *     (fail-closed, like userReadFence).
 *   - Every caller: the predicate's registry row policy (requiresScope,
 *     e.g. brain:read_pii, then ABAC) decides whether the value is shown.
 *     A row that fails keeps its ids, predicate and reason, with `object`
 *     and the source's content (evidence quotes) redacted. A tenant-wide
 *     key sees another user's personal row redacted too: omitting a user
 *     never mixes personal memory in.
 *
 * Pure module apart from the two id lookups; the caller owns the db
 * handle and the filter's finish().
 */

export const REDACTED = '[redacted]';

/** Owner of a dead letter: a user id, tenant-global, or not determinable. */
export type DeadLetterOwner = { kind: 'user'; userId: string } | { kind: 'global' } | null;

export interface DeadLetterPayloadRow {
  id?: unknown;
  payload?: Record<string, unknown> | undefined;
}

export interface DeadLetterFence {
  /** The end user a user-bound token acts for; undefined for a tenant-wide key. */
  authUserId: string | undefined;
  rowPolicy: RowPolicyFilter;
}

/** Source keys that are ids, never content; everything else is dropped on redaction. */
const SOURCE_ID_KEYS = [
  'vertical',
  'documentId',
  'conversationId',
  'messageId',
  'eventId',
  'episodeIds',
] as const;

interface OwnerRow {
  id?: unknown;
  userId?: unknown;
}

type QueryHandle = Pick<Surreal, 'query'>;

function refOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.includes(':') ? s : null;
}

function sourceOf(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const src = payload?.source;
  return src && typeof src === 'object' && !Array.isArray(src)
    ? (src as Record<string, unknown>)
    : null;
}

function userOf(row: OwnerRow | undefined): string | undefined {
  return typeof row?.userId === 'string' && row.userId.length > 0 ? row.userId : undefined;
}

/**
 * Resolve each row's owner with two bounded id lookups (entities named,
 * documents cited). Read ids first, then match in memory.
 */
export async function resolveDeadLetterOwners(
  db: QueryHandle,
  rows: readonly DeadLetterPayloadRow[],
): Promise<DeadLetterOwner[]> {
  const entityRefs = new Set<string>();
  const docRefs = new Set<string>();
  for (const r of rows) {
    const ent = refOf(r.payload?.entityId);
    if (ent) entityRefs.add(ent);
    const doc = refOf(sourceOf(r.payload)?.documentId);
    if (doc) docRefs.add(doc);
  }
  const entities = new Map<string, OwnerRow>();
  const documents = new Map<string, OwnerRow>();
  if (entityRefs.size > 0) {
    const [found] = await db.query<[OwnerRow[]]>(
      `SELECT id, userId FROM knowledge_entity WHERE id INSIDE $ids`,
      { ids: [...entityRefs].map((id) => new StringRecordId(id)) },
    );
    for (const e of found ?? []) entities.set(String(e.id), e);
  }
  if (docRefs.size > 0) {
    const [found] = await db.query<[OwnerRow[]]>(
      `SELECT id, userId FROM source_document WHERE id INSIDE $ids`,
      { ids: [...docRefs].map((id) => new StringRecordId(id)) },
    );
    for (const d of found ?? []) documents.set(String(d.id), d);
  }
  return rows.map((r) => ownerOf(r, entities, documents));
}

function ownerOf(
  r: DeadLetterPayloadRow,
  entities: Map<string, OwnerRow>,
  documents: Map<string, OwnerRow>,
): DeadLetterOwner {
  const explicit = r.payload?.userId;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { kind: 'user', userId: explicit };
  }
  const ent = refOf(r.payload?.entityId);
  const entUser = ent ? userOf(entities.get(ent)) : undefined;
  if (entUser) return { kind: 'user', userId: entUser };
  const docRef = refOf(sourceOf(r.payload)?.documentId);
  const doc = docRef ? documents.get(docRef) : undefined;
  if (doc) {
    const docUser = userOf(doc);
    return docUser ? { kind: 'user', userId: docUser } : { kind: 'global' };
  }
  return null;
}

/** The payload with the value and the source's content removed; ids stay. */
export function redactDeadLetterPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(payload ?? {}) };
  if ('object' in out) out.object = REDACTED;
  const src = sourceOf(payload);
  if (src) {
    const kept: Record<string, unknown> = {};
    for (const k of SOURCE_ID_KEYS) if (src[k] !== undefined) kept[k] = src[k];
    out.source = kept;
  }
  out.redacted = true;
  return out;
}

/**
 * Apply the fences to rows whose owners were resolved in the same order.
 * Returns the rows to show (dropped ones are absent), each with its
 * payload redacted when the caller may not read its value.
 */
export function fenceDeadLetters<R extends DeadLetterPayloadRow>(
  rows: readonly R[],
  owners: readonly DeadLetterOwner[],
  fence: DeadLetterFence,
): Array<R & { payload: Record<string, unknown> }> {
  const out: Array<R & { payload: Record<string, unknown> }> = [];
  rows.forEach((row, i) => {
    const owner = owners[i] ?? null;
    if (fence.authUserId !== undefined) {
      const own = owner?.kind === 'user' && owner.userId === fence.authUserId;
      if (!own && owner?.kind !== 'global') return;
    }
    const personalOfAnother = owner?.kind === 'user' && owner.userId !== fence.authUserId;
    const predicate = row.payload?.predicate;
    const readable =
      !personalOfAnother &&
      typeof predicate === 'string' &&
      fence.rowPolicy.filter({
        id: row.id,
        predicate,
        source: row.payload?.source,
        userId: owner?.kind === 'user' ? owner.userId : null,
      });
    out.push({
      ...row,
      payload: readable ? (row.payload ?? {}) : redactDeadLetterPayload(row.payload),
    });
  });
  return out;
}

/** The listed shape of a fenced row (AdminDeadLetterRow). */
export interface FencedDeadLetter {
  companyId: string;
  id: string;
  reason: string;
  rejectedAt: string;
  payload: Record<string, unknown>;
}

/**
 * One tenant's dead letters through the fences, for the request in
 * context: owners resolved, the user-bound caller pinned, the predicate
 * row policy (the tenant's registry lookup) applied per row.
 */
export async function readDeadLetters(
  db: QueryHandle,
  p: {
    companyId: string;
    rows: Array<DeadLetterPayloadRow & { reason: string; rejectedAt: string | Date }>;
    scopes: readonly string[];
    /** The tenant's predicate registry (requiresScope per predicate); absent → seed policies. */
    registry?: Pick<PredicateRegistryService, 'rowPolicyLookup'> | undefined;
  },
): Promise<FencedDeadLetter[]> {
  if (p.rows.length === 0) return [];
  const rowPolicy = makeRowPolicyFilter({
    callerScopes: p.scopes,
    surface: 'admin_dead_letter',
    policyLookup: await p.registry?.rowPolicyLookup(p.companyId),
  });
  try {
    // A failed owner lookup degrades to "owner unknown" (fail-closed for
    // a user-bound caller), never to a failed list or overview.
    const owners = await resolveDeadLetterOwners(db, p.rows).catch(() =>
      p.rows.map((): DeadLetterOwner => null),
    );
    return fenceDeadLetters(p.rows, owners, {
      authUserId: pinUserScope(undefined),
      rowPolicy,
    }).map((r) => ({
      companyId: p.companyId,
      id: String(r.id),
      reason: r.reason,
      rejectedAt: new Date(r.rejectedAt).toISOString(),
      payload: r.payload,
    }));
  } finally {
    rowPolicy.finish();
  }
}
