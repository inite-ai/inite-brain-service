import { Injectable, Logger } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import {
  SurrealService,
  retryOnUniqueViolation,
  isUniqueViolation,
  queryRows,
  queryFirst,
} from '../db/surreal.service';
import { BrainScope } from '../auth/api-key.types';
import { CODE_MEMORY_PACK } from '../ai/domain-packs';

export interface AnchorRow {
  anchor: string;
  entityId: string;
  factIds: string[];
}

/** A code-memory knowledge_fact row as read by listAnchors. */
interface AnchorFactRow {
  id: unknown;
  entityId: unknown;
  refs?: Record<string, string> | null;
}

/** The entity row read to mirror externalRefs during reanchor. */
interface EntityRefsRow {
  externalRefs?: Record<string, string> | null;
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
  async listAnchors(companyId: string, scopes: BrainScope[]): Promise<AnchorRow[]> {
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // Half-open predicate range rides fact_predicate_idx; the previous
      // string::starts_with defeated the index (full scan + per-row
      // entityId deref). LIMIT bounds the admin listing.
      const rows = await queryRows<AnchorFactRow>(
        db,
        `SELECT id, entityId, entityId.externalRefs AS refs
           FROM knowledge_fact
           WHERE predicate >= $prefix AND predicate < $prefixEnd
             AND retractedAt IS NONE
           LIMIT 5000`,
        { prefix: this.prefix, prefixEnd: `${this.prefix}￿` },
      );
      const byAnchor = new Map<string, AnchorRow>();
      for (const r of rows) {
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
  async invalidateAnchor(companyId: string, anchor: string, reason: string): Promise<number> {
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
      const updated = await queryRows<{ id: unknown }>(
        db,
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
      const n = updated.length;
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
      const ent = await queryFirst<EntityRefsRow>(
        db,
        `SELECT externalRefs FROM type::record('knowledge_entity', $eid) LIMIT 1`,
        { eid: idTail(entityId) },
      );
      const refs = ent?.externalRefs ?? {};
      await db.query(`UPDATE type::record('knowledge_entity', $eid) SET externalRefs = $refs`, {
        eid: idTail(entityId),
        refs: { ...refs, [newKey]: newAnchor },
      });
      this.logger.log(`Re-anchored ${oldAnchor} → ${newAnchor} (${companyId})`);
      return { reanchored: true };
    });
  }

  private async resolveEntity(db: Surreal, anchor: string): Promise<string | null> {
    const key = externalRefKey('code', anchor);
    const first = await queryFirst<unknown>(
      db,
      `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key },
    );
    return first ? String(first) : null;
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
