import { Injectable, Logger } from '@nestjs/common';
import {
  SurrealService,
  retryOnUniqueViolation,
  isUniqueViolation,
} from '../db/surreal.service';
import { BrainScope } from '../auth/api-key.types';
import { CODE_MEMORY_PACK } from '../ai/domain-packs';

export interface AnchorRow {
  anchor: string;
  entityId: string;
  factIds: string[];
}

/**
 * Server side of the code-memory anchor re-validation sweep (Phase 2b). The
 * client (which has the code) lists anchors, checks each against the current
 * source, and applies verdicts:
 *   - reanchor  — a symbol moved/renamed: point the old anchor's entity at the
 *     new symbol id too (facts preserved, `why(newAnchor)` starts resolving).
 *   - invalidate — the symbol/file is gone: retract the anchor's active facts
 *     (retractedAt set — dropped from `why`; row kept for audit, never deleted).
 * Symbol anchors survive line shifts on their own; this handles the harder
 * rename/delete drift.
 */
@Injectable()
export class CodeMemoryAnchorService {
  private readonly logger = new Logger(CodeMemoryAnchorService.name);
  private readonly prefix = `${CODE_MEMORY_PACK.id}__`;

  constructor(private readonly surreal: SurrealService) {}

  /** All code anchors currently carrying active code-memory facts. */
  async listAnchors(
    companyId: string,
    scopes: BrainScope[],
  ): Promise<AnchorRow[]> {
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT id, entityId, entityId.externalRefs AS refs
           FROM knowledge_fact
           WHERE string::starts_with(predicate, $prefix)
             AND retractedAt IS NONE`,
        { prefix: this.prefix },
      );
      const byAnchor = new Map<string, AnchorRow>();
      for (const r of (rows as any[]) ?? []) {
        const anchor = anchorOf(r.refs);
        if (!anchor) continue;
        const existing = byAnchor.get(anchor);
        if (existing) {
          existing.factIds.push(String(r.id));
        } else {
          byAnchor.set(anchor, {
            anchor,
            entityId: String(r.entityId),
            factIds: [String(r.id)],
          });
        }
      }
      return [...byAnchor.values()];
    });
  }

  /** Retract the active code-memory facts on an anchor (drift: symbol/file gone). */
  async invalidateAnchor(
    companyId: string,
    anchor: string,
    reason: string,
  ): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const entityId = await this.resolveEntity(db, anchor);
      if (!entityId) return 0;
      // status = 'retracted' matches the canonical retract shape
      // (facts.service.ts) — recall_decisions filters by status, so a
      // retractedAt-only write would leave invalidated decisions in
      // semantic recall forever. Scoping to status = 'active' (not just
      // retractedAt IS NONE) keeps superseded rows untouched: they carry
      // the retractionReason = 'superseded' sentinel that revive +
      // calibration depend on, and they are already out of every read.
      const [updated] = await db.query<[any[]]>(
        `UPDATE knowledge_fact
           SET status = 'retracted',
               retractedAt = time::now(),
               retractedBy = 'system',
               retractionReason = $reason
           WHERE entityId = type::record('knowledge_entity', $eid)
             AND string::starts_with(predicate, $prefix)
             AND status = 'active'
             AND retractedAt IS NONE
           RETURN AFTER`,
        { eid: idTail(entityId), prefix: this.prefix, reason },
      );
      const n = ((updated as any[]) ?? []).length;
      this.logger.log(
        `Invalidated ${n} code-memory fact(s) at anchor ${anchor} (${companyId}): ${reason}`,
      );
      return n;
    });
  }

  /** Add `newAnchor` as an alias external-ref of `oldAnchor`'s entity, so the
   *  preserved facts resolve under the moved/renamed symbol too. */
  async reanchor(
    companyId: string,
    oldAnchor: string,
    newAnchor: string,
  ): Promise<{ reanchored: boolean; reason?: string }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const entityId = await this.resolveEntity(db, oldAnchor);
      if (!entityId) return { reanchored: false, reason: 'old anchor not found' };
      const newKey = externalRefKey('code', newAnchor);
      try {
        await retryOnUniqueViolation(async () => {
          await db.query(
            `CREATE entity_external_ref CONTENT { key: $key, entity: type::record('knowledge_entity', $eid) }`,
            { key: newKey, eid: idTail(entityId) },
          );
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          return { reanchored: false, reason: 'new anchor already exists' };
        }
        throw e;
      }
      // Mirror into the entity's externalRefs map (read-merge-write).
      const [ent] = await db.query<[any[]]>(
        `SELECT externalRefs FROM type::record('knowledge_entity', $eid) LIMIT 1`,
        { eid: idTail(entityId) },
      );
      const refs = ((ent as any[]) ?? [])[0]?.externalRefs ?? {};
      await db.query(
        `UPDATE type::record('knowledge_entity', $eid) SET externalRefs = $refs`,
        { eid: idTail(entityId), refs: { ...refs, [newKey]: newAnchor } },
      );
      this.logger.log(
        `Re-anchored ${oldAnchor} → ${newAnchor} (${companyId})`,
      );
      return { reanchored: true };
    });
  }

  private async resolveEntity(db: any, anchor: string): Promise<string | null> {
    const key = externalRefKey('code', anchor);
    const [rows] = await db.query(
      `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key },
    );
    const arr = (rows as any[]) ?? [];
    return arr[0] ? String(arr[0]) : null;
  }
}

function anchorOf(refs: Record<string, string> | undefined | null): string {
  if (!refs) return '';
  for (const [k, v] of Object.entries(refs)) {
    if (k.startsWith('code__')) return String(v);
  }
  return '';
}

// Mirrors externalRefKey() in src/ingest/ingest-utils.ts (write side): dots → __.
function externalRefKey(vertical: string, id: string): string {
  const safe = (s: string) => s.replace(/\./g, '__');
  return `${safe(vertical)}__${safe(id)}`;
}

function idTail(entityId: string): string {
  const i = entityId.indexOf(':');
  return i === -1 ? entityId : entityId.slice(i + 1);
}
