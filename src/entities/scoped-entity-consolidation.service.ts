import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows } from '../db/surreal.service';
import { EntityUpsertService } from '../ingest/entity-upsert.service';
import { createEdgeBetween } from '../ingest/edge-writer';
import { externalRefKey } from '../ingest/ingest-utils';
import { USER_ENTITY_VERTICAL } from '../ingest/user-entity';

/** The scope marker `scopedRefKey` folds into a reference key. */
const SCOPE_MARKER = '::u::';

export interface ConsolidationResult {
  companyId: string;
  /** Legacy per-user reference rows found. */
  scanned: number;
  /** Copies folded into a tenant-global twin. */
  merged: number;
  /** Copies that had no twin and became the tenant-global node themselves. */
  rekeyed: number;
  factsMoved: number;
  edgesMoved: number;
  /** Identical active facts collapsed onto the earliest one after a merge. */
  duplicatesFolded: number;
}

interface LegacyRef {
  id: unknown;
  key: string;
  entity: unknown;
}

interface EdgeRow {
  id: unknown;
  in: unknown;
  out: unknown;
  kind: string;
  weight: number;
  source: Record<string, unknown>;
  userId?: string | null;
  createdAt: unknown;
  invalidatedAt?: unknown;
  validFrom?: Date | null;
  validUntil?: Date | null;
}

/**
 * Folds the per-user entity copies of the 0055 era back into tenant-wide
 * identity.
 *
 * Until 2026-09-20 a `{vertical, id}` reference written with a userId
 * minted its own entity under the key `<vertical>__<id>::u::<userId>`,
 * separate from the tenant-global node the mention path resolves the same
 * thing to. One referent became two nodes: the copy held the record_fact
 * history, the tenant node the mention facts, and the conflict machinery,
 * the entity timeline and the connections each saw half of the memory.
 * The write rule is now "identity is tenant-wide, scope is on the fact"
 * (EntityUpsertService.resolveOrCreateEntity); this pass converges the
 * rows written before it, once per tenant:
 *
 *  - a copy whose tenant-global twin exists (by reference key, or by the
 *    same name the ref id spells) is MERGED into it: facts, corroboration
 *    checks, scene links and edges move over (facts keep their own userId
 *    — nothing becomes visible to anyone new), the copy's reference rows
 *    point at the twin, the copy is left as a `mergedInto` redirect;
 *  - a copy with no twin is RE-KEYED: it becomes the tenant-global node
 *    for that reference (its facts stay personal by their userId).
 *
 * After a merge, facts the same user wrote about the same slot on both
 * nodes meet for the first time. The resolver would have made a repeated
 * identical claim `corroborating`; the pass applies exactly that to
 * identical active facts (same predicate, object and scope), keeping the
 * earliest as the record. Facts with different values in one slot are
 * left as they are — the resolver's supersede/compete verdicts depend on
 * predicate semantics and arrival order the pass cannot replay honestly,
 * and the serving side arbitrates them by time.
 *
 * Idempotent: a converged tenant has no `::u::` reference rows outside the
 * user's own node (`user__<id>::u::<id>`, which is private by design and
 * untouched), so a second run scans and does nothing. Runs once per
 * (process, tenant) off the schema-ready hook, and on demand through the
 * admin maintenance route.
 */
@Injectable()
export class ScopedEntityConsolidationService {
  private readonly logger = new Logger(ScopedEntityConsolidationService.name);
  private readonly pending = new Set<string>();
  private readonly seen = new Set<string>();
  private draining = false;

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly entities?: EntityUpsertService,
  ) {}

  onModuleInit(): void {
    this.surreal.onTenantSchemaReady((companyId) => this.noteTenant(companyId));
  }

  /** The hook body — allocation only; the work runs off the request path. */
  noteTenant(companyId: string): void {
    if (this.seen.has(companyId) || this.pending.has(companyId)) return;
    this.pending.add(companyId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const companyId of this.pending) {
        this.pending.delete(companyId);
        this.seen.add(companyId);
        try {
          const r = await this.consolidate(companyId);
          if (r.scanned > 0) {
            this.logger.log(
              `[entities.consolidate] ${companyId}: ${r.scanned} legacy per-user cop${r.scanned === 1 ? 'y' : 'ies'} — merged ${r.merged}, rekeyed ${r.rekeyed}, facts ${r.factsMoved}, edges ${r.edgesMoved}, duplicates folded ${r.duplicatesFolded}`,
            );
          }
        } catch (err) {
          this.logger.warn(`[entities.consolidate] ${companyId} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async consolidate(companyId: string): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      companyId,
      scanned: 0,
      merged: 0,
      rekeyed: 0,
      factsMoved: 0,
      edgesMoved: 0,
      duplicatesFolded: 0,
    };
    await this.surreal.withCompany(companyId, async (db) => {
      const refs = await queryRows<LegacyRef>(
        db,
        `SELECT id, key, entity FROM entity_external_ref WHERE string::contains(key, $marker)`,
        { marker: SCOPE_MARKER },
      );
      for (const ref of refs) {
        const at = ref.key.indexOf(SCOPE_MARKER);
        const base = ref.key.slice(0, at);
        const userId = ref.key.slice(at + SCOPE_MARKER.length);
        // The user's own node is private by design — its key keeps the scope.
        if (base === externalRefKey(USER_ENTITY_VERTICAL, userId)) continue;
        result.scanned += 1;
        const copy = String(ref.entity);
        const twin = await this.findTwin(db, base, copy);
        if (twin === null) {
          await this.rekey(db, { refId: ref.id, base, key: ref.key, copy });
          result.rekeyed += 1;
          continue;
        }
        const moved = await this.merge(db, { refId: ref.id, copy, twin });
        result.merged += 1;
        result.factsMoved += moved.facts;
        result.edgesMoved += moved.edges;
        result.duplicatesFolded += moved.duplicates;
      }
    });
    return result;
  }

  /**
   * The tenant-global node this reference names: the row under the plain
   * key, else a tenant-global entity spelled exactly like the ref id (the
   * `adopt` rule of the write path). Never the copy itself.
   */
  private async findTwin(db: Surreal, base: string, copy: string): Promise<string | null> {
    const byKey = await queryRows<{ entity: unknown }>(
      db,
      `SELECT entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key: base },
    );
    const viaKey = byKey[0] ? String(byKey[0].entity) : null;
    if (viaKey === copy) return null;
    if (viaKey) return viaKey;
    // The ref id as the caller spelled it — the value under the copy's key.
    const rows = await queryRows<{ v: Record<string, unknown> | null }>(
      db,
      `SELECT externalRefs AS v FROM $copy`,
      { copy: new StringRecordId(copy) },
    );
    const refs = rows[0]?.v ?? {};
    const spelled = Object.entries(refs).find(([k]) => k.startsWith(`${base}${SCOPE_MARKER}`))?.[1];
    const name = typeof spelled === 'string' ? spelled : base.slice(base.indexOf('__') + 2);
    const byName = await this.entities?.resolveExistingByName(db, { name });
    return byName && byName !== copy ? byName : null;
  }

  /** No twin: the copy IS the tenant node for this reference from now on. */
  private async rekey(
    db: Surreal,
    p: { refId: unknown; base: string; key: string; copy: string },
  ): Promise<void> {
    await db.query(
      `UPDATE $ref SET key = $base;
       UPDATE $copy SET
         userId = NONE,
         scope = array::filter(scope ?? [], |$t| string::starts_with($t, 'user:') = false),
         externalRefs = object::from_entries(array::map(object::entries(externalRefs ?? {}), |$kv| IF $kv[0] = $old THEN [$base, $kv[1]] ELSE $kv END));`,
      {
        ref: recordId(p.refId),
        base: p.base,
        old: p.key,
        copy: new StringRecordId(p.copy),
      },
    );
  }

  private async merge(
    db: Surreal,
    p: { refId: unknown; copy: string; twin: string },
  ): Promise<{ facts: number; edges: number; duplicates: number }> {
    const copy = new StringRecordId(p.copy);
    const twin = new StringRecordId(p.twin);
    // Facts, corroboration checks, scene links. The SELECT-then-UPDATE
    // idiom: a WHERE over a compound-indexed field can match nothing on
    // 3.2 (the changefeed/GDPR lesson).
    const [, , factIds] = await db.query<[unknown, unknown, unknown[]]>(
      `LET $ids = (SELECT VALUE id FROM knowledge_fact WHERE entityId = $copy);
       UPDATE $ids SET entityId = $twin;
       RETURN $ids;`,
      { copy, twin },
    );
    await db.query(
      `LET $c = (SELECT VALUE id FROM corroborate_checked WHERE entityId = $copy);
       UPDATE $c SET entityId = $twin;
       LET $scenes = (SELECT VALUE id FROM memory_episode WHERE entityIds CONTAINS $copy);
       UPDATE $scenes SET entityIds = array::distinct(array::map(entityIds, |$e| IF $e = $copy THEN $twin ELSE $e END));
       LET $dossiers = (SELECT VALUE id FROM knowledge_artifact WHERE entityId = $copy OR entityId = $twin);
       DELETE $dossiers;`,
      { copy, twin },
    );
    const edges = await this.moveEdges(db, { copy: p.copy, twin: p.twin });
    // Reference rows: the legacy scoped key goes; any other reference the
    // copy carried now names the twin. Aliases and name keys travel.
    await db.query(
      `DELETE $ref;
       LET $refs = (SELECT VALUE id FROM entity_external_ref WHERE entity = $copy);
       UPDATE $refs SET entity = $twin;
       LET $c = (SELECT aliases, nameKeys, canonicalName FROM ONLY $copy);
       UPDATE $twin SET
         aliases = array::distinct(array::concat(aliases ?? [], array::concat($c.aliases ?? [], [$c.canonicalName]))),
         nameKeys = array::distinct(array::concat(nameKeys ?? [], $c.nameKeys ?? []));
       UPDATE $copy SET mergedInto = $twin, mergedAt = time::now();`,
      { ref: recordId(p.refId), copy, twin },
    );
    const duplicates = await this.foldIdenticalActives(db, p.twin);
    return { facts: (factIds as unknown[] | undefined)?.length ?? 0, edges, duplicates };
  }

  /**
   * Edges are relation records with immutable endpoints: each edge of the
   * copy is re-created on the twin through the one edge primitive (same
   * scope, same kind — idempotent against an edge the twin already has),
   * carrying its timestamps, and the copy's edge is removed.
   */
  private async moveEdges(db: Surreal, p: { copy: string; twin: string }): Promise<number> {
    const copy = new StringRecordId(p.copy);
    const rows = await queryRows<EdgeRow>(
      db,
      `SELECT id, in, out, kind, weight, source, userId, createdAt, invalidatedAt, validFrom, validUntil
         FROM knowledge_edge WHERE in = $copy OR out = $copy`,
      { copy },
    );
    let moved = 0;
    for (const e of rows) {
      const from = String(e.in) === p.copy ? p.twin : String(e.in);
      const to = String(e.out) === p.copy ? p.twin : String(e.out);
      if (from === to) {
        await db.query(`DELETE $id`, { id: recordId(e.id) });
        continue;
      }
      const newId = await createEdgeBetween(db, {
        fromEntityId: from,
        toEntityId: to,
        kind: e.kind,
        source: e.source ?? {},
        weight: e.weight,
        userId: e.userId ?? undefined,
        // The period the relation held travels with it (0164).
        ...(e.validFrom ? { validFrom: toDate(e.validFrom) } : {}),
        ...(e.validUntil ? { validUntil: toDate(e.validUntil) } : {}),
      });
      if (newId && newId !== String(e.id)) {
        // The earlier of the two creation times, and a closed edge stays
        // closed — the twin's own copy of the relation wins otherwise.
        await db.query(
          `UPDATE $new SET
             createdAt = IF createdAt > $createdAt THEN $createdAt ELSE createdAt END,
             invalidatedAt = invalidatedAt ?? $invalidatedAt`,
          {
            new: new StringRecordId(newId),
            createdAt: e.createdAt,
            invalidatedAt: e.invalidatedAt ?? undefined,
          },
        );
      }
      await db.query(`DELETE $id`, { id: recordId(e.id) });
      moved += 1;
    }
    return moved;
  }

  /**
   * The resolver's corroboration rule, applied after the fact: a repeated
   * identical claim in one scope is one record plus corroborations, not
   * two actives. Keeps the earliest recorded as the record.
   */
  private async foldIdenticalActives(db: Surreal, entityId: string): Promise<number> {
    const rows = await queryRows<{
      id: unknown;
      predicate: string;
      object: string;
      userId?: string | null;
      recordedAt: unknown;
    }>(
      db,
      `SELECT id, predicate, object, userId, recordedAt FROM knowledge_fact
        WHERE entityId = $e AND status = 'active' AND retractedAt IS NONE
        ORDER BY recordedAt ASC`,
      { e: new StringRecordId(entityId) },
    );
    const first = new Map<string, unknown>();
    let folded = 0;
    for (const r of rows) {
      const slot = [r.predicate, r.object, r.userId ?? ''].join('|');
      const keeper = first.get(slot);
      if (keeper === undefined) {
        first.set(slot, r.id);
        continue;
      }
      await db.query(`UPDATE $id SET status = 'corroborating', corroborates = $keeper`, {
        id: recordId(r.id),
        keeper: recordId(keeper),
      });
      folded += 1;
    }
    return folded;
  }
}

function recordId(v: unknown): StringRecordId {
  return new StringRecordId(String(v));
}

/** A Surreal datetime (DateTime or Date) as a JS Date. */
function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const d = v as { toDate?: () => Date };
  return typeof d.toDate === 'function' ? d.toDate() : new Date(String(v));
}
