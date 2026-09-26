import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { LocalNerService } from '../ai/local-ner.service';
import {
  MEMORY_EDGES_PER_ENTITY,
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
import { UserEntityService } from './user-entity.service';
import { UNKNOWN_START } from './event-time';

/** Names looked up per turn — the turn's own plus the conversation's. */
const MAX_NAMES = 16;
/** Entities shown; the facts cap follows from MEMORY_FACTS_PER_ENTITY. */
const MAX_ENTITIES = 10;
/** Conversations whose recent entities are remembered in-process, and how many per conversation. */
const CONVERSATION_CACHE_MAX = 2000;
const CONVERSATION_ENTITIES_MAX = 12;
/** The tenant's predicate vocabulary changes slowly; one read per minute is plenty. */
const PREDICATES_TTL_MS = 60_000;
const PREDICATES_CACHE_MAX = 512;

/**
 * When a stored fact or relation was SAID: the occurrence of the document
 * it was read from, else (written without one — record_fact, the direct
 * mention path) the instant it was written, which is when it was said.
 */
const SAID_AT = (written: string): string =>
  `((IF source.documentId != NONE THEN type::record(source.documentId).occurredAt END) ?? ${written})`;

function isoOf(v: string | Date | undefined): string | undefined {
  return v instanceof Date ? v.toISOString() : v;
}

export interface MemoryContextInput {
  companyId: string;
  /** The current turn (PII-redacted, as the extractor will see it). */
  text: string;
  occurredAt?: string | Date | undefined;
  conversationId?: string | undefined;
  /** The current turn's own message id, excluded from the earlier turns. */
  messageId?: string | undefined;
  /**
   * Earlier turns are the ones said BEFORE this instant. A turn is
   * captured when it arrives and read later, so the conversation may
   * already hold turns that came after it.
   */
  before?: string | Date | undefined;
  /**
   * The facts and relations shown are the ones SAID no later than this
   * instant (defaults to `before`). A text is read against what was said
   * up to it: an old document read after a newer one (an import out of
   * order, a retry, a re-read) must not see the newer values, or it names
   * them as what it replaces and the stale value becomes current.
   */
  saidBy?: string | Date | undefined;
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
  /**
   * The entities the last turns of a conversation committed, keyed
   * `companyId|conversationId`. A subject the extractor filed a turn
   * under is not always a name NER can find again ("воркер
   * синхронизации", "the pilot") — without this the next turn of the
   * same conversation did not see the facts it was about to update
   * (measured on prod 2026-09-18: turn 2 pinned Fluenta and Ana but saw
   * 0 facts, and nothing superseded). A cache, not a record: a miss
   * (another replica, a restart) degrades to the name lookups.
   */
  private readonly conversationEntities = new Map<string, string[]>();

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
    @Optional() private readonly ner?: LocalNerService,
    @Optional() private readonly users?: UserEntityService,
  ) {}

  /**
   * Remember what a turn of a conversation committed, for the next turn's
   * context. A commit also changes the tenant's vocabulary, so the cached
   * predicate list goes with it: under a fixed TTL every turn of a
   * tenant's first minute read the list its first turn had cached (one
   * predicate, for eleven turns, on the 2026-09-18 stand) — the young
   * tenant, whose vocabulary moves with every turn, is exactly the one
   * that needs it fresh; a quiet tenant keeps the cache.
   */
  remember(companyId: string, conversationId: string | undefined, entityIds: string[]): void {
    this.predicateCache.delete(companyId);
    if (!conversationId || entityIds.length === 0) return;
    const key = `${companyId}|${conversationId}`;
    const prior = this.conversationEntities.get(key) ?? [];
    const next = [...entityIds, ...prior.filter((id) => !entityIds.includes(id))].slice(
      0,
      CONVERSATION_ENTITIES_MAX,
    );
    // Re-insert so the map's order is recency; evict the oldest key.
    this.conversationEntities.delete(key);
    this.conversationEntities.set(key, next);
    if (this.conversationEntities.size > CONVERSATION_CACHE_MAX) {
      const oldest = this.conversationEntities.keys().next().value;
      if (oldest !== undefined) this.conversationEntities.delete(oldest);
    }
  }

  async build(p: MemoryContextInput): Promise<MemoryContext | undefined> {
    const occurredAt =
      p.occurredAt instanceof Date ? p.occurredAt.toISOString() : (p.occurredAt ?? undefined);
    try {
      return await traceSpan('ingest.memory_context', async () => {
        const ctx = await this.surreal.withCompany(p.companyId, async (db) => {
          const recentTurns = await this.recentTurns(db, p);
          const names = await this.candidateNames(p, recentTurns);
          const ids = await this.lookupIds(db, {
            own: await this.ownEntity(db, p.userId),
            names,
            userId: p.userId,
            remembered: this.remembered(p),
          });
          const [entities, predicates] = await Promise.all([
            this.knownEntities(db, ids),
            this.predicates(db, p.companyId),
          ]);
          const saidBy = isoOf(p.saidBy ?? p.before);
          const facts = await this.knownFacts(db, entities, { userId: p.userId, saidBy });
          const edges = await this.knownEdges(db, entities, {
            userId: p.userId,
            saidBy,
            offset: facts.length,
          });
          return { occurredAt, recentTurns, entities, facts: [...facts, ...edges], predicates };
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

  /**
   * Whether the text names an entity the memory is using now — one with a
   * fact in open conflict (COMPETING), a state expected to end but not yet
   * ended (expectedUntil ahead), or a fact an answer has verifiably used
   * (0107). New raw about such an entity is read in full and never left
   * raw: it is where the memory is being asked and where it may be wrong
   * (docs/roadmap/raw-processing-triggers-2026-09.md §4.2 T-5).
   *
   * Only the entities the text itself names count — not the user's own
   * entity (every first-person turn would be "in use") nor what the
   * conversation was about before. Read-only; a failure reads as not in
   * use (the triage still decides).
   */
  async inUse(p: {
    companyId: string;
    text: string;
    userId?: string | undefined;
    participants?: string[] | undefined;
  }): Promise<boolean> {
    try {
      return await this.surreal.withCompany(p.companyId, async (db) => {
        const names = await this.candidateNames({ ...p, participants: [] }, []);
        const ids = await this.lookupIds(db, {
          own: undefined,
          names,
          userId: p.userId,
          remembered: [],
        });
        if (ids.length === 0) return false;
        const userGate = p.userId ? '(userId IS NONE OR userId = $u)' : 'userId IS NONE';
        const [open, used] = await db.query<[Array<unknown>, Array<unknown>]>(
          `SELECT VALUE id FROM knowledge_fact
             WHERE entityId IN $ids AND retractedAt IS NONE AND ${userGate}
               AND (status = 'competing'
                 OR (status = 'active' AND validUntil IS NONE
                     AND expectedUntil != NONE AND expectedUntil > time::now()))
             LIMIT 1;
           SELECT VALUE id FROM memory_outcome_stat
             WHERE subjectId IN (SELECT VALUE id FROM knowledge_fact
                                   WHERE entityId IN $ids AND retractedAt IS NONE AND ${userGate})
               AND verifiedUseCount + confirmedCount > 0
             LIMIT 1;`,
          { ids: ids.map(recordRef), u: p.userId },
        );
        return (open ?? []).length > 0 || (used ?? []).length > 0;
      });
    } catch (e) {
      this.logger.warn(`in-use check failed (companyId=${p.companyId}): ${(e as Error).message}`);
      return false;
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
          ${p.before ? 'AND occurredAt < type::datetime($before)' : ''}
        ORDER BY occurredAt DESC LIMIT $k`,
      {
        c: p.conversationId,
        m: p.messageId,
        u: p.userId,
        k: MEMORY_RECENT_TURNS,
        before: p.before instanceof Date ? p.before.toISOString() : p.before,
      },
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

  private remembered(p: MemoryContextInput): string[] {
    return p.conversationId
      ? (this.conversationEntities.get(`${p.companyId}|${p.conversationId}`) ?? [])
      : [];
  }

  /**
   * The user's own entity (user-entity.ts) is a known entity of every
   * turn of theirs — a first-person turn updates ITS facts ("I moved to
   * Berlin" closes `lives_in: Riga`), and no name in the turn would find
   * it (the turn says "I"; the entity may still be named by the userId).
   * Resolved by its key, never by name: a same-named third party in
   * someone's notes must not stand in for the user.
   */
  private async ownEntity(db: Surreal, userId: string | undefined): Promise<string | undefined> {
    if (!userId || !this.users) return undefined;
    return (await this.users.lookup(db, userId))?.id;
  }

  private async lookupIds(
    db: Surreal,
    {
      own,
      names,
      userId,
      remembered,
    }: {
      own: string | undefined;
      names: string[];
      userId: string | undefined;
      remembered: string[];
    },
  ): Promise<string[]> {
    const found = await Promise.all(
      names.map((name) => this.entities.resolveExistingByName(db, { name }, { userId })),
    );
    const ids: string[] = [];
    // The user first, then the names (the turn's own subjects), then
    // what the conversation's last turns were filed under.
    for (const id of [own, ...found, ...remembered]) {
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
    opts: { userId: string | undefined; saidBy: string | undefined },
  ): Promise<MemoryFact[]> {
    const { userId, saidBy } = opts;
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
          validUntil?: unknown;
          expectedUntil?: unknown;
        }>,
      ]
    >(
      `SELECT id, entityId, predicate, object, validFrom, validUntil, expectedUntil FROM knowledge_fact
        WHERE entityId IN $ids AND status IN ['active', 'competing'] AND retractedAt IS NONE
          AND ${userGate}${saidBy ? ` AND ${SAID_AT('recordedAt')} <= type::datetime($said)` : ''}
        ORDER BY validFrom DESC LIMIT $k`,
      { ids: ids.map(recordRef), u: userId, said: saidBy, k: MEMORY_FACTS_PER_ENTITY * ids.length },
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
        since: sinceDay(r.validFrom),
        // A value that has ENDED is listed with its end, not hidden: a
        // turn may correct that period, and the extractor must see it is
        // history rather than read it as the current value.
        until: toIso(r.validUntil).slice(0, 10) || undefined,
        // An ended value has no expectation to show; its end is known.
        expectedUntil: r.validUntil ? undefined : toIso(r.expectedUntil).slice(0, 10) || undefined,
      });
    }
    return out;
  }

  /**
   * The known entities' live relations, after the facts under the same
   * handle series — a relation the turn replaces ("moved to Hetzner"
   * against `e2 — runs_on → Fly.io`) is closed through `supersedes`
   * exactly like a fact; without this an edge outlived the value it
   * mirrored and stood beside the new one on every read (found on the
   * 2026-09-18 dogfood: `runs_on → Fly.io` next to `runs_on: Hetzner`).
   * Peer names come off the entity rows; the user fence is the edge
   * fence's (tenant-global + own).
   */
  private async knownEdges(
    db: Surreal,
    entities: MemoryEntity[],
    opts: { userId: string | undefined; saidBy: string | undefined; offset: number },
  ): Promise<MemoryFact[]> {
    const { userId, saidBy, offset } = opts;
    if (entities.length === 0) return [];
    const ids = entities.map((e) => e.id);
    const handleOf = new Map(entities.map((e) => [e.id, e.handle]));
    const userGate = userId ? '(userId IS NONE OR userId = $u)' : 'userId IS NONE';
    const [rows] = await db.query<
      [
        Array<{
          id: unknown;
          in: unknown;
          out: unknown;
          kind: string;
          fromName: string | null;
          toName: string | null;
          createdAt: unknown;
          validFrom?: unknown;
        }>,
      ]
    >(
      `SELECT id, in, out, kind, in.canonicalName AS fromName, out.canonicalName AS toName, createdAt, validFrom
         FROM knowledge_edge
        WHERE (in IN $ids OR out IN $ids) AND invalidatedAt IS NONE AND ${userGate}${saidBy ? ` AND ${SAID_AT('createdAt')} <= type::datetime($said)` : ''}
        ORDER BY createdAt DESC LIMIT $k`,
      { ids: ids.map(recordRef), u: userId, said: saidBy, k: MEMORY_EDGES_PER_ENTITY * ids.length },
    );
    const perEntity = new Map<string, number>();
    const out: MemoryFact[] = [];
    for (const r of rows ?? []) {
      const from = String(r.in);
      const to = String(r.out);
      // The known side is the anchor; an edge between two known entities
      // reads from its subject.
      const [entityId, edge, peer] = handleOf.has(from)
        ? [from, 'out' as const, r.toName]
        : [to, 'in' as const, r.fromName];
      const entityHandle = handleOf.get(entityId);
      if (!entityHandle || !peer) continue;
      const n = perEntity.get(entityId) ?? 0;
      if (n >= MEMORY_EDGES_PER_ENTITY) continue;
      perEntity.set(entityId, n + 1);
      out.push({
        handle: `m${offset + out.length + 1}`,
        id: String(r.id),
        entityHandle,
        predicate: r.kind,
        object: peer,
        // Since when it holds (0164) — the write instant only for a
        // relation that predates valid time on edges.
        since: toIso(r.validFrom ?? r.createdAt).slice(0, 10) || undefined,
        edge,
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

/**
 * A known fact's start day, or undefined when it has none worth showing:
 * a value stated only with its end starts at UNKNOWN_START, which would
 * read to the model as "since 1970".
 */
function sinceDay(v: unknown): string | undefined {
  const iso = toIso(v);
  if (!iso || Date.parse(iso) === UNKNOWN_START.getTime()) return undefined;
  return iso.slice(0, 10);
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
