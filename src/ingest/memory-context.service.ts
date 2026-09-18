import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { LocalNerService } from '../ai/local-ner.service';
import {
  MEMORY_FACTS_PER_ENTITY,
  MEMORY_PREDICATES,
  MEMORY_RECENT_TURNS,
  type MemoryContext,
  type MemoryEntity,
  type MemoryFact,
  type MemoryTurn,
} from '../ai/extractor-internals/memory-context';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { EntityUpsertService } from './entity-upsert.service';

/** Names looked up per turn — the turn's own plus the conversation's. */
const MAX_NAMES = 16;
/** Entities shown; the facts cap follows from MEMORY_FACTS_PER_ENTITY. */
const MAX_ENTITIES = 10;
/** The tenant's predicate vocabulary changes slowly; one read per minute is plenty. */
const PREDICATES_TTL_MS = 60_000;
const PREDICATES_CACHE_MAX = 512;

export interface MemoryContextInput {
  companyId: string;
  /** The current turn (PII-redacted, as the extractor will see it). */
  text: string;
  occurredAt?: string | Date | undefined;
  conversationId?: string | undefined;
  /** The current turn's own message id, excluded from the earlier turns. */
  messageId?: string | undefined;
  /** Scope key of the end user; omitted → tenant-global memory only. */
  userId?: string | undefined;
  /** Participant names the caller asserted (speaker / addressee). */
  participants?: string[] | undefined;
}

/**
 * Builds the memory context an extraction reads (memory-context.ts):
 * the earlier turns of the conversation, the entities the turn and
 * those turns name that the graph already files, their current facts,
 * and the tenant's living predicate vocabulary.
 *
 * Read-only and cheap by construction: names come from the local NER
 * (already cached per text — the extractor's own pre-pass runs it on
 * the same turn), each name is looked up through the resolver's
 * read-only ladder (exact / transliteration / article / code alias —
 * no embedding, no judge, nothing written), and the rest is three
 * indexed reads. Every failure degrades to a smaller context, never to
 * a failed ingest.
 */
@Injectable()
export class MemoryContextService {
  private readonly logger = new Logger(MemoryContextService.name);
  private readonly predicateCache = new Map<string, { at: number; predicates: string[] }>();

  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
    @Optional() private readonly ner?: LocalNerService,
  ) {}

  async build(p: MemoryContextInput): Promise<MemoryContext | undefined> {
    const occurredAt =
      p.occurredAt instanceof Date ? p.occurredAt.toISOString() : (p.occurredAt ?? undefined);
    try {
      return await traceSpan('ingest.memory_context', async () => {
        const ctx = await this.surreal.withCompany(p.companyId, async (db) => {
          const recentTurns = await this.recentTurns(db, p);
          const names = await this.candidateNames(p, recentTurns);
          const ids = await this.lookupIds(db, names, p.userId);
          const [entities, predicates] = await Promise.all([
            this.knownEntities(db, ids),
            this.predicates(db, p.companyId),
          ]);
          const facts = await this.knownFacts(db, entities, p.userId);
          return { occurredAt, recentTurns, entities, facts, predicates };
        });
        traceArtifact('extractor.memory_context', {
          recentTurns: ctx.recentTurns.length,
          entities: ctx.entities.map((e) => `${e.handle}:${e.name}`),
          facts: ctx.facts.length,
          predicates: ctx.predicates.length,
        });
        return ctx;
      });
    } catch (e) {
      this.logger.warn(
        `memory context unavailable (companyId=${p.companyId}): ${(e as Error).message}`,
      );
      // The date alone still anchors the extraction.
      return occurredAt
        ? { occurredAt, recentTurns: [], entities: [], facts: [], predicates: [] }
        : undefined;
    }
  }

  private async recentTurns(db: Surreal, p: MemoryContextInput): Promise<MemoryTurn[]> {
    if (!p.conversationId) return [];
    const userGate = p.userId ? '(userId IS NONE OR userId = $u)' : 'userId IS NONE';
    const [rows] = await db.query<
      [Array<{ speaker?: string | null; text: string; occurredAt: unknown; messageId: string }>]
    >(
      `SELECT speaker, text, occurredAt, messageId FROM episode
        WHERE conversationId = $c AND kind = 'turn' AND ${userGate}
          ${p.messageId ? 'AND messageId != $m' : ''}
        ORDER BY occurredAt DESC LIMIT $k`,
      { c: p.conversationId, m: p.messageId, u: p.userId, k: MEMORY_RECENT_TURNS },
    );
    return (rows ?? [])
      .map((r) => ({
        at: toIso(r.occurredAt),
        ...(r.speaker ? { speaker: r.speaker } : {}),
        text: r.text,
      }))
      .reverse();
  }

  /** Proper names the turn and the conversation mention, most recent first. */
  private async candidateNames(p: MemoryContextInput, turns: MemoryTurn[]): Promise<string[]> {
    const texts = [p.text, ...turns.map((t) => t.text).reverse()];
    const names: string[] = [...(p.participants ?? [])];
    if (this.ner?.isReady()) {
      for (const text of texts) {
        const spans = await this.ner.extract(text).catch(() => []);
        for (const s of spans) names.push(s.text);
        if (names.length >= MAX_NAMES * 2) break;
      }
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of names) {
      const key = n.trim().toLowerCase();
      if (key.length < 2 || seen.has(key)) continue;
      seen.add(key);
      out.push(n.trim());
      if (out.length >= MAX_NAMES) break;
    }
    return out;
  }

  private async lookupIds(
    db: Surreal,
    names: string[],
    userId: string | undefined,
  ): Promise<string[]> {
    const found = await Promise.all(
      names.map((name) => this.entities.resolveExistingByName(db, { name }, { userId })),
    );
    const ids: string[] = [];
    for (const id of found) {
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_ENTITIES) break;
    }
    return ids;
  }

  private async knownEntities(db: Surreal, ids: string[]): Promise<MemoryEntity[]> {
    if (ids.length === 0) return [];
    const [rows] = await db.query<
      [Array<{ id: unknown; canonicalName: string; type: string; mergedInto?: unknown }>]
    >(`SELECT id, canonicalName, type, mergedInto FROM knowledge_entity WHERE id IN $ids`, {
      ids: ids.map(recordRef),
    });
    // Handles follow the lookup order, so a turn's own names come first.
    const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));
    const out: MemoryEntity[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || r.mergedInto) continue;
      out.push({ handle: `e${out.length + 1}`, id, name: r.canonicalName, type: r.type });
    }
    return out;
  }

  private async knownFacts(
    db: Surreal,
    entities: MemoryEntity[],
    userId: string | undefined,
  ): Promise<MemoryFact[]> {
    if (entities.length === 0) return [];
    const ids = entities.map((e) => e.id);
    const handleOf = new Map(entities.map((e) => [e.id, e.handle]));
    const userGate = userId ? '(userId IS NONE OR userId = $u)' : 'userId IS NONE';
    const [rows] = await db.query<
      [
        Array<{
          id: unknown;
          entityId: unknown;
          predicate: string;
          object: string;
          validFrom: unknown;
        }>,
      ]
    >(
      `SELECT id, entityId, predicate, object, validFrom FROM knowledge_fact
        WHERE entityId IN $ids AND status IN ['active', 'competing'] AND retractedAt IS NONE
          AND ${userGate}
        ORDER BY validFrom DESC LIMIT $k`,
      { ids: ids.map(recordRef), u: userId, k: MEMORY_FACTS_PER_ENTITY * ids.length },
    );
    const perEntity = new Map<string, number>();
    const out: MemoryFact[] = [];
    for (const r of rows ?? []) {
      const entityId = String(r.entityId);
      const n = perEntity.get(entityId) ?? 0;
      if (n >= MEMORY_FACTS_PER_ENTITY) continue;
      perEntity.set(entityId, n + 1);
      const entityHandle = handleOf.get(entityId);
      if (!entityHandle) continue;
      out.push({
        handle: `m${out.length + 1}`,
        id: String(r.id),
        entityHandle,
        predicate: r.predicate,
        object: r.object,
        since: toIso(r.validFrom).slice(0, 10) || undefined,
      });
    }
    return out;
  }

  private async predicates(db: Surreal, companyId: string): Promise<string[]> {
    const hit = this.predicateCache.get(companyId);
    if (hit && Date.now() - hit.at < PREDICATES_TTL_MS) return hit.predicates;
    const [rows] = await db.query<[Array<{ predicate: string; n: number }>]>(
      `SELECT predicate, count() AS n FROM knowledge_fact
        WHERE status = 'active' GROUP BY predicate ORDER BY n DESC LIMIT $k`,
      { k: MEMORY_PREDICATES },
    );
    const predicates = (rows ?? []).map((r) => r.predicate).filter((p) => typeof p === 'string');
    // An empty vocabulary is a tenant's first minutes, not a fact worth
    // remembering: the next turn re-reads.
    if (predicates.length === 0) return predicates;
    if (this.predicateCache.size >= PREDICATES_CACHE_MAX) {
      const oldest = this.predicateCache.keys().next().value;
      if (oldest !== undefined) this.predicateCache.delete(oldest);
    }
    this.predicateCache.set(companyId, { at: Date.now(), predicates });
    return predicates;
  }
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  }
  return '';
}

function recordRef(id: string): StringRecordId {
  // Record ids arrive as "table:key" strings; the SDK needs the typed form.
  return new StringRecordId(id);
}
