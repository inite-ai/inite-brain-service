import { Injectable } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { scopeForUser } from '../auth/scope-tags';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import type { SourceItem } from '../contracts/source-plane/source-plane.schema';
import type { ItemDescriptor } from './connector';

/** Raw `source_item` row. */
export interface SourceItemRow {
  id: unknown;
  connectionId: unknown;
  externalId: string;
  originUri?: string | null;
  path?: string | null;
  title?: string | null;
  mediaType?: string | null;
  size?: number | null;
  revision?: string | null;
  fetchedRevision?: string | null;
  modifiedAt?: unknown;
  byteHash?: string | null;
  contentHash?: string | null;
  assetId?: string | null;
  documentId?: string | null;
  episodeId?: string | null;
  acl?: Record<string, unknown> | null;
  state: SourceItem['state'];
  firstSeenAt?: unknown;
  lastSeenAt?: unknown;
  hitCount?: number | null;
  deepenedAt?: unknown;
  goneAt?: unknown;
  lastError?: string | null;
  userId?: string | null;
  scope?: string[];
  /**
   * Not a column: set on the row `upsertSeen` returns when the item was
   * gone and is seen again — the instant the delete policy closed its
   * facts at, so an ingest that turns out byte-identical can reopen them.
   */
  resurrectedAt?: Date | undefined;
}

export interface UpsertOutcome {
  row: SourceItemRow;
  /** Never catalogued before. */
  isNew: boolean;
  /** New, or the enumerated revision differs from the fetched one. */
  changed: boolean;
}

/**
 * SourceItemService — the catalogue (raw-evidence-sources-2026-09.md
 * § 5.2): one row per external item per connection, identity by
 * LOCATION. Every mutation is a primary-key write — SELECT the id, then
 * UPDATE $id — never `UPDATE … WHERE` over the UNIQUE compound (the
 * 3.2.4 planner silently matches zero rows on a compound-indexed WHERE).
 */
@Injectable()
export class SourceItemService {
  constructor(private readonly surreal: SurrealService) {}

  /** Record what `enumerate` saw. Idempotent on (connection, externalId). */
  async upsertSeen(
    companyId: string,
    p: {
      connectionId: string;
      userId: string | null;
      item: ItemDescriptor;
      seenAt: Date;
    },
  ): Promise<UpsertOutcome> {
    return this.surreal.withCompany(companyId, async (db) => {
      const existing = await this.findByExternalId(db, p.connectionId, p.item.externalId);
      const descriptor = {
        ...(p.item.originUri !== undefined ? { originUri: p.item.originUri } : {}),
        ...(p.item.path !== undefined ? { path: p.item.path } : {}),
        ...(p.item.title !== undefined ? { title: p.item.title } : {}),
        ...(p.item.mediaType !== undefined ? { mediaType: p.item.mediaType } : {}),
        ...(p.item.size !== undefined ? { size: p.item.size } : {}),
        ...(p.item.revision !== undefined ? { revision: p.item.revision } : {}),
        ...(p.item.modifiedAt !== undefined ? { modifiedAt: new Date(p.item.modifiedAt) } : {}),
        ...(p.item.acl !== undefined ? { acl: p.item.acl } : {}),
      };
      if (!existing) {
        const [created] = await queryRows<SourceItemRow>(
          db,
          `CREATE source_item CONTENT $content`,
          {
            content: {
              connectionId: connectionRef(p.connectionId),
              externalId: p.item.externalId,
              ...descriptor,
              state: 'seen',
              firstSeenAt: p.seenAt,
              lastSeenAt: p.seenAt,
              ...(p.userId ? { userId: p.userId } : {}),
              scope: scopeForUser(p.userId ?? undefined),
            },
          },
        );
        if (!created) throw new Error('source_item create returned no row');
        return { row: created, isNew: true, changed: true };
      }
      // A resurrected item (gone → seen again) is a change; so is a
      // revision that differs from the one the content was fetched at.
      const wasGone = existing.state === 'gone';
      const revisionMoved =
        p.item.revision !== undefined && p.item.revision !== (existing.fetchedRevision ?? null);
      const neverFetched = existing.fetchedRevision == null && existing.state === 'seen';
      const changed = wasGone || revisionMoved || neverFetched;
      // One SET clause per present field (an UPDATE takes exactly one
      // data clause); option<> fields take NONE, never a bound JS null,
      // so the resurrection clears goneAt inline.
      const { sets, vars } = setClauses({ ...descriptor, lastSeenAt: p.seenAt });
      if (wasGone) sets.push(`state = 'seen'`, `goneAt = NONE`);
      const [updated] = await queryRows<SourceItemRow>(db, `UPDATE $id SET ${sets.join(', ')}`, {
        id: existing.id,
        ...vars,
      });
      const row = updated ?? existing;
      const goneAt = wasGone ? asDate(existing.goneAt) : null;
      return { row: goneAt ? { ...row, resurrectedAt: goneAt } : row, isNew: false, changed };
    });
  }

  /** The content landed: link what it produced and pin the revision. */
  async markIndexed(
    companyId: string,
    p: {
      itemId: string;
      revision: string | null;
      documentId?: string | undefined;
      assetId?: string | undefined;
      episodeId?: string | undefined;
      contentHash?: string | undefined;
      byteHash?: string | undefined;
    },
  ): Promise<void> {
    const { sets, vars } = setClauses({
      state: 'indexed',
      ...(p.revision !== null ? { fetchedRevision: p.revision } : {}),
      ...(p.documentId !== undefined ? { documentId: p.documentId } : {}),
      ...(p.assetId !== undefined ? { assetId: p.assetId } : {}),
      ...(p.episodeId !== undefined ? { episodeId: p.episodeId } : {}),
      ...(p.contentHash !== undefined ? { contentHash: p.contentHash } : {}),
      ...(p.byteHash !== undefined ? { byteHash: p.byteHash } : {}),
    });
    sets.push('lastError = NONE');
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE type::record('source_item', $tail) SET ${sets.join(', ')}`, {
        tail: idTailOf(p.itemId),
        ...vars,
      }),
    );
  }

  async markFailed(companyId: string, itemId: string, error: string): Promise<void> {
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE type::record('source_item', $tail) SET lastError = $error`, {
        tail: idTailOf(itemId),
        error: error.slice(0, 500),
      }),
    );
  }

  /** One item the source reported gone (incremental) — by location. */
  async markGoneByExternalId(
    companyId: string,
    p: { connectionId: string; externalId: string; at: Date },
  ): Promise<SourceItemRow | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const existing = await this.findByExternalId(db, p.connectionId, p.externalId);
      if (!existing || existing.state === 'gone') return null;
      const [updated] = await queryRows<SourceItemRow>(
        db,
        `UPDATE $id SET state = 'gone', goneAt = $at`,
        { id: existing.id, at: p.at },
      );
      return updated ?? existing;
    });
  }

  /**
   * Full-walk reconciliation: everything live that the walk did not
   * touch is gone. Bounded per call; the caller loops. Returns the rows
   * it closed so the engine can apply the delete policy to each.
   */
  async markUnseenGone(
    companyId: string,
    p: { connectionId: string; runStartedAt: Date; goneAt: Date; limit?: number },
  ): Promise<SourceItemRow[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<SourceItemRow>(
        db,
        `SELECT * FROM source_item WHERE connectionId = type::record('source_connection', $tail) AND state != 'gone' AND lastSeenAt < $start LIMIT $limit`,
        { tail: idTailOf(p.connectionId), start: p.runStartedAt, limit: p.limit ?? 500 },
      );
      if (rows.length === 0) return [];
      await db.query(`UPDATE $ids SET state = 'gone', goneAt = $at`, {
        ids: rows.map((r) => r.id),
        at: p.goneAt,
      });
      return rows.map((r) => ({ ...r, state: 'gone' as const, goneAt: p.goneAt }));
    });
  }

  /** The named rows of one connection — the deepening half of W6. */
  async byIds(
    companyId: string,
    connectionId: string,
    itemIds: readonly string[],
  ): Promise<SourceItemRow[]> {
    if (itemIds.length === 0) return [];
    return this.surreal.withCompany(companyId, (db) =>
      queryRows<SourceItemRow>(
        db,
        `SELECT * FROM source_item
          WHERE connectionId = type::record('source_connection', $tail)
            AND id IN $ids AND state != 'gone' LIMIT 100`,
        {
          tail: idTailOf(connectionId),
          ids: itemIds.slice(0, 100).map((id) => new StringRecordId(id)),
        },
      ),
    );
  }

  /**
   * A retrieval hit on a catalogue row: the counter that decides which
   * manifest-only items are worth reading (W6). Bumping it is not
   * reading the item — the deepening is a separate, budgeted step.
   */
  async recordHits(companyId: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(`UPDATE $ids SET hitCount += 1, lastHitAt = $at`, {
        ids: itemIds.map((id) => new StringRecordId(id)),
        at: new Date(),
      });
    });
  }

  /** Stamp the rows a deepening run read, so a second hit does not re-queue them. */
  async markDeepened(companyId: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(`UPDATE $ids SET deepenedAt = $at`, {
        ids: itemIds.map((id) => new StringRecordId(id)),
        at: new Date(),
      });
    });
  }

  /** Rows a run marked gone (explicitly or by the unseen sweep) since it started. */
  async goneSince(
    companyId: string,
    p: { connectionId: string; since: Date },
  ): Promise<SourceItemRow[]> {
    return this.surreal.withCompany(companyId, (db) =>
      queryRows<SourceItemRow>(
        db,
        `SELECT * FROM source_item WHERE connectionId = type::record('source_connection', $tail) AND state = 'gone' AND goneAt >= $since LIMIT 10000`,
        { tail: idTailOf(p.connectionId), since: p.since },
      ),
    );
  }

  async list(
    companyId: string,
    p: {
      connectionId: string;
      state?: SourceItem['state'] | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: SourceItem[]; total: number }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const where = `connectionId = type::record('source_connection', $tail)${
        p.state ? ' AND state = $state' : ''
      }`;
      const vars = {
        tail: idTailOf(p.connectionId),
        ...(p.state ? { state: p.state } : {}),
        limit: p.limit,
        offset: p.offset,
      };
      const rows = await queryRows<SourceItemRow>(
        db,
        `SELECT * FROM source_item WHERE ${where} ORDER BY lastSeenAt DESC LIMIT $limit START $offset`,
        vars,
      );
      const count = await queryFirst<{ n: number }>(
        db,
        `SELECT count() AS n FROM source_item WHERE ${where} GROUP ALL`,
        vars,
      );
      return { items: rows.map(toItemView), total: count?.n ?? 0 };
    });
  }

  /** One catalogue row by its source id, or null. */
  async getByExternalId(
    companyId: string,
    p: { connectionId: string; externalId: string },
  ): Promise<SourceItemRow | null> {
    return this.surreal.withCompany(companyId, (db) =>
      this.findByExternalId(db, p.connectionId, p.externalId),
    );
  }

  private async findByExternalId(
    db: Parameters<Parameters<SurrealService['withCompany']>[1]>[0],
    connectionId: string,
    externalId: string,
  ): Promise<SourceItemRow | null> {
    const row = await queryFirst<SourceItemRow>(
      db,
      `SELECT * FROM source_item WHERE connectionId = type::record('source_connection', $tail) AND externalId = $externalId LIMIT 1`,
      { tail: idTailOf(connectionId), externalId },
    );
    return row ?? null;
  }
}

/** `field = $v_field` pairs + their bound vars, for the present fields only. */
function setClauses(fields: Record<string, unknown>): {
  sets: string[];
  vars: Record<string, unknown>;
} {
  const sets: string[] = [];
  const vars: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${field} = $v_${field}`);
    vars[`v_${field}`] = value;
  }
  return { sets, vars };
}

function connectionRef(connectionId: string): unknown {
  return new StringRecordId(`source_connection:${idTailOf(connectionId)}`);
}

/**
 * SurrealDB datetimes reach the SDK as Date, ISO string or epoch number
 * — and, under jest's vm realm, as a Date from ANOTHER realm that fails
 * `instanceof`; `new Date(value)` accepts all of them.
 */
function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'object') {
    const d = new Date(v as string | number | Date);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function toItemView(row: SourceItemRow): SourceItem {
  return {
    id: String(row.id),
    connectionId: String(row.connectionId),
    externalId: row.externalId,
    originUri: row.originUri ?? null,
    path: row.path ?? null,
    title: row.title ?? null,
    mediaType: row.mediaType ?? null,
    size: row.size ?? null,
    revision: row.revision ?? null,
    fetchedRevision: row.fetchedRevision ?? null,
    modifiedAt: toIso(row.modifiedAt),
    documentId: row.documentId ?? null,
    assetId: row.assetId ?? null,
    episodeId: row.episodeId ?? null,
    state: row.state,
    firstSeenAt: toIso(row.firstSeenAt) ?? new Date(0).toISOString(),
    lastSeenAt: toIso(row.lastSeenAt) ?? new Date(0).toISOString(),
    goneAt: toIso(row.goneAt),
    lastError: row.lastError ?? null,
    hitCount: row.hitCount ?? 0,
    deepenedAt: toIso(row.deepenedAt),
  };
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}
