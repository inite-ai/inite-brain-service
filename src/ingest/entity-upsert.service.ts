import { Injectable, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import {
  dbCreate,
  retryOnUniqueViolation,
  runTransaction,
} from '../db/surreal.service';
import { EntityResolverService } from './entity-resolver.service';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { externalRefKey } from './ingest-utils';

/**
 * Entity-resolution slice of the ingest pipeline: turn a caller-supplied
 * reference (externalRef / canonical name / bare entityId) into a concrete
 * knowledge_entity id, minting one when absent. Every method takes the live
 * `db` from the surrounding `withCompany` session, so this service carries no
 * SurrealService dep of its own — only the optional inline resolver.
 *
 * Shared by all three ingest paths: typed fact (resolveOrCreateEntity),
 * mention (resolveOrCreateNamedEntity), and link (resolveOrCreateBareRef).
 */
@Injectable()
export class EntityUpsertService {
  constructor(
    // @Optional: when the resolver isn't wired (or its flag is off), the
    // mention path simply skips inline resolution and creates new as before.
    @Optional() private readonly entityResolver?: EntityResolverService,
  ) {}

  /**
   * Resolve an entity by externalRef, creating it if absent. Atomic against
   * concurrent ingests — relies on UNIQUE on entity_external_ref.key. The
   * pattern is: indexed read first (the common path), and on miss enter a
   * transaction that re-reads under tx scope and creates both rows or neither.
   * On a unique violation (another caller created the same ref between our
   * read and write) we retry; the next read finds the row.
   */
  async resolveOrCreateEntity(db: Surreal, dto: IngestFactDto): Promise<string> {
    if ('entityId' in dto.entityRef && dto.entityRef.entityId) {
      return dto.entityRef.entityId;
    }
    const ref = dto.entityRef as { vertical: string; id: string };
    const refKey = externalRefKey(ref.vertical, ref.id);
    return this.upsertEntityByExternalRef(db, refKey, () => ({
      type: 'other',
      canonicalName: ref.id,
      externalRefs: { [refKey]: ref.id },
    }));
  }

  async upsertEntityByExternalRef(
    db: Surreal,
    key: string,
    factory: () => Record<string, unknown>,
  ): Promise<string> {
    // SurrealDB v2.2.8 surfaces concurrent UNIQUE-key CREATEs as either
    // a unique-index violation or a commit-time read/write conflict;
    // both are caught by retryOnUniqueViolation. The retry's second
    // SELECT picks up the racing committer's row.
    return retryOnUniqueViolation(async () => {
      const fast = await this.lookupExternalRef(db, key);
      if (fast) return fast;

      const content = factory();
      const result = await runTransaction<{ id: unknown } | null>(db, (tx) => {
        tx.bind('content', content);
        tx.bind('key', key);
        tx.add('LET $new = (CREATE ONLY knowledge_entity CONTENT $content)');
        tx.add('CREATE entity_external_ref CONTENT { key: $key, entity: $new.id }');
        tx.add('RETURN $new');
      });
      return String(result?.id);
    });
  }

  private async lookupExternalRef(db: Surreal, key: string): Promise<string | null> {
    const [rows] = await db.query<[any[]]>(
      `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key },
    );
    const arr = (rows as any[]) ?? [];
    return arr[0] ? String(arr[0]) : null;
  }

  async resolveOrCreateNamedEntity({
    db,
    e,
    hint,
    _contextRef,
    incomingFacts = [],
  }: {
    db: Surreal;
    e: { name: string; type: string; canonical?: string };
    hint: { vertical: string; id: string; role?: string } | undefined;
    _contextRef: { vertical: string };
    incomingFacts?: string[];
  }): Promise<string> {
    // 1. Caller hint wins — same atomic upsert as fact ingest.
    if (hint) {
      const hintKey = externalRefKey(hint.vertical, hint.id);
      return this.upsertEntityByExternalRef(db, hintKey, () => ({
        type: this.normalizeEntityType(e.type),
        canonicalName: e.canonical ?? e.name,
        aliases: [e.name],
        externalRefs: { [hintKey]: hint.id },
      }));
    }

    // 2. Canonical-name match. Hits `entity_canonical_lc_idx` directly
    // via the stored `canonicalNameLc` VALUE field — no per-row
    // `string::lowercase()` evaluation needed. Two concurrent ingests
    // of the same name can still both miss and both create; we accept
    // the rare alias-only dup (same legal entity, two records) since
    // name canonicalisation is heuristic. Identity merge via
    // ingestLink consolidates downstream.
    const target = (e.canonical ?? e.name).toLowerCase();
    const [nRows] = await db.query<any[][]>(
      `SELECT id FROM knowledge_entity
       WHERE canonicalNameLc = $name
          OR aliases CONTAINS $rawName
       LIMIT 1`,
      { name: target, rawName: e.name },
    );
    const nRow = ((nRows as any[]) ?? [])[0];
    if (nRow) return String(nRow.id);

    // 3. Inline entity resolution (graphiti-style, opt-in). Before minting
    // a new entity, look for a near-duplicate that already exists and let
    // an LLM judge confirm same-as using the incoming facts. A confirmed
    // match reuses the existing entity, so the duplicate is never created.
    // Falls through to create-new when disabled, no match, or any error.
    if (this.entityResolver?.isEnabled()) {
      const resolved = await this.entityResolver.resolveByName({
        db,
        name: e.name,
        type: this.normalizeEntityType(e.type),
        incomingFacts,
      });
      if (resolved) return resolved;
    }

    const created = await dbCreate<any>(db, 'knowledge_entity', {
      type: this.normalizeEntityType(e.type),
      canonicalName: e.canonical ?? e.name,
      aliases: [e.name],
      externalRefs: {},
    });
    return String(created?.id);
  }

  async resolveOrCreateBareRef(
    db: Surreal,
    ref: { vertical: string; id: string } | { entityId: string },
  ): Promise<string> {
    if ('entityId' in ref && ref.entityId) {
      return ref.entityId.includes(':') ? ref.entityId : `knowledge_entity:${ref.entityId}`;
    }
    const r = ref as { vertical: string; id: string };
    const refKey = externalRefKey(r.vertical, r.id);
    return this.upsertEntityByExternalRef(db, refKey, () => ({
      type: 'other',
      canonicalName: r.id,
      externalRefs: { [refKey]: r.id },
    }));
  }

  private normalizeEntityType(t: string): string {
    const allowed = ['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other'];
    return allowed.includes(t) ? t : 'other';
  }
}
