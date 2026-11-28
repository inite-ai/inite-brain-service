import { StringRecordId, type Surreal } from 'surrealdb';
import { pinUserScope, userReadFence } from '../auth/user-scope';
import type { PolicyFilterableRow, RowPolicyFilter } from '../policy/row-filter';

/**
 * What the dreams surfaces show of the facts a run touched.
 *
 * A resolution (resolver.service) and a corroboration
 * (corroborate.service) carry the two facts' values (`winnerObject` /
 * `loserObject`, `incumbentObject` / `corroboratingObject`). Those are
 * memory content of any user and any predicate, and they reached a
 * tenant's brain:admin through the run trigger's response and the per-run
 * emit drill, past brain:read_pii and past the per-user fence.
 *
 *   - The run trigger (POST /v1/dreams/run, POST /v1/admin/dreams/run)
 *     answers counts and ids; every value is `[redacted]` (the contract
 *     keeps the field, a string).
 *   - The emit rows are written without the values (ids, predicate,
 *     entity, method are enough to audit a run).
 *   - Reading the emit drill applies the fences to rows written before
 *     that: both facts must pass userReadFence (a user-bound key sees
 *     its own and tenant-global facts; another user's emit is absent,
 *     and so is one whose facts are gone — fail-closed) and the
 *     registry row policy (requiresScope + ABAC); otherwise the values
 *     are redacted. A tenant-wide key sees a personal fact's emit with the
 *     values redacted.
 */

export const REDACTED = '[redacted]';

/** Detail keys that hold a fact's value, per emit kind. */
const VALUE_KEYS: Record<string, readonly string[]> = {
  resolution: ['winnerObject', 'loserObject'],
  corroboration: ['incumbentObject', 'corroboratingObject'],
};

/** A copy of `detail` with every value key of `kind` set to REDACTED. */
export function redactEmitDetail<T extends object>(kind: string, detail: T): T {
  const keys = VALUE_KEYS[kind] ?? [];
  const out = { ...detail } as Record<string, unknown>;
  for (const k of keys) if (k in out) out[k] = REDACTED;
  return out as T;
}

interface RunStatsWithValues {
  resolve?: { resolutions: object[] } | undefined;
  corroborate?: { corroborations: object[] } | undefined;
}

/** The run-trigger response: counts and ids, never the facts' values. */
export function redactDreamRunStats<T extends RunStatsWithValues>(stats: T): T {
  return {
    ...stats,
    ...(stats.resolve
      ? {
          resolve: {
            ...stats.resolve,
            resolutions: stats.resolve.resolutions.map((r) => redactEmitDetail('resolution', r)),
          },
        }
      : {}),
    ...(stats.corroborate
      ? {
          corroborate: {
            ...stats.corroborate,
            corroborations: stats.corroborate.corroborations.map((c) =>
              redactEmitDetail('corroboration', c),
            ),
          },
        }
      : {}),
  };
}

/** Emit detail as stored: the value keys are dropped, not kept for later. */
export function emitDetailForStorage<T extends object>(kind: string, detail: T): Partial<T> {
  const keys = VALUE_KEYS[kind] ?? [];
  const out = { ...detail } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as Partial<T>;
}

export interface DreamEmitRow {
  kind?: unknown;
  subject?: unknown;
  object?: unknown;
  detail?: unknown;
  [k: string]: unknown;
}

interface FactPolicyRow extends PolicyFilterableRow {
  id: unknown;
}

/** The two facts of a value-carrying emit: the writer stores them as subject/object. */
function factIdsOf(row: DreamEmitRow): string[] {
  const kind = typeof row.kind === 'string' ? row.kind : '';
  if (!VALUE_KEYS[kind]) return [];
  return [row.subject, row.object].map((v) => (v === undefined || v === null ? '' : String(v)));
}

/**
 * Apply the read fences to one run's emit rows. Rows of kinds that carry
 * no fact value (identity_link: two entity ids and a cosine) pass as-is.
 */
export async function fenceDreamEmits(
  db: Pick<Surreal, 'query'>,
  rows: readonly DreamEmitRow[],
  rowPolicy: RowPolicyFilter,
): Promise<DreamEmitRow[]> {
  const fence = userReadFence(undefined);
  const userBound = pinUserScope(undefined) !== undefined;
  const wanted = new Set<string>();
  for (const r of rows) for (const id of factIdsOf(r)) if (id.includes(':')) wanted.add(id);
  const visible = new Map<string, FactPolicyRow>();
  if (wanted.size > 0) {
    const [found] = await db.query<[FactPolicyRow[]]>(
      `SELECT id, predicate, userId, source, trustSnapshot, corroboration
         FROM knowledge_fact WHERE id INSIDE $ids AND ${fence.clause}`,
      { ids: [...wanted].map((id) => new StringRecordId(id)), ...fence.params },
    );
    for (const f of found ?? []) visible.set(String(f.id), f);
  }
  const out: DreamEmitRow[] = [];
  for (const r of rows) {
    const kind = typeof r.kind === 'string' ? r.kind : '';
    if (!VALUE_KEYS[kind]) {
      out.push(r);
      continue;
    }
    const facts = factIdsOf(r).map((id) => visible.get(id));
    const allVisible = facts.every((f) => f !== undefined);
    if (userBound && !allVisible) continue;
    const readable = allVisible && facts.every((f) => rowPolicy.filter(f!));
    out.push(
      readable || !r.detail || typeof r.detail !== 'object'
        ? r
        : { ...r, detail: redactEmitDetail(kind, r.detail) },
    );
  }
  return out;
}
