/**
 * The memory context of one extraction: what the graph already knows
 * about the turn — the earlier turns of its conversation, the entities
 * it names that are already filed, their current facts, and the
 * predicate vocabulary this tenant actually uses.
 *
 * WHY THE EXTRACTOR SEES MEMORY. Extracting a turn in isolation is what
 * made the graph incoherent in ways no downstream pass could repair.
 * Measured on an 11-turn business dialogue (2026-09-18): the same
 * budget landed on two different subjects across turns (the "pilot" in
 * turn 1, the client in turn 4), the same attribute under two names
 * (planned_start / start_month), a moved deadline beside the old one
 * with both active, a first name filed as a new person, and generic
 * nouns (the report, the board, Friday) minted as entities — one of
 * which cross-linked two unrelated projects and produced a false answer.
 * Every SOTA memory system resolves this the same way: Mem0 retrieves
 * the memories the new message touches and lets the model decide
 * add/update; Graphiti gives the extractor the existing nodes and edges
 * of the episode's neighbourhood and asks for contradictions. The
 * decision that needs judgement — "is this the same attribute of the
 * same thing, and does it replace what we hold?" — is made ONCE, by the
 * model that reads the sentence, with the memory in front of it.
 *
 * The context is rendered as handles ([e1] for entities, [m3] for
 * facts) that the extractor references back: `known` on an entity
 * pins the mention to an existing node without a resolution ladder or
 * a judge call; `supersedes` on a fact closes the exact rows the new
 * value replaces, whatever their predicate was spelled as. Handles
 * are mapped back to record ids here, by a pure function, so an
 * invented handle can never reach the graph.
 */

export interface MemoryTurn {
  /** ISO instant the turn occurred. */
  at: string;
  speaker?: string | undefined;
  text: string;
}

export interface MemoryEntity {
  /** Prompt handle: e1, e2, … */
  handle: string;
  /** knowledge_entity record id. */
  id: string;
  name: string;
  type: string;
}

export interface MemoryFact {
  /** Prompt handle: m1, m2, … */
  handle: string;
  /** knowledge_fact record id — or knowledge_edge, for a relation. */
  id: string;
  /** Handle of the known entity the fact (or relation) sits on. */
  entityHandle: string;
  predicate: string;
  /** The value; for a relation, the peer's name. */
  object: string;
  /** Calendar day the fact has been valid from (YYYY-MM-DD), for display. */
  since?: string | undefined;
  /**
   * Set for a relation (a knowledge_edge): 'out' — the known entity is
   * the subject (`e2 — runs_on → Fly.io`), 'in' — the peer is
   * (`Pedro Lima — covers_for → e1`). A relation is knowledge the graph
   * holds about the entity like any fact, and a turn that replaces it
   * ("moved to Hetzner") closes it the same way — through `supersedes`.
   */
  edge?: 'out' | 'in' | undefined;
}

/** One KNOWN FACTS line: a fact as `e2 · predicate: value`, a relation in its own direction. */
export function renderMemoryFact(f: MemoryFact): string {
  const since = f.since ? ` (since ${f.since})` : '';
  if (f.edge === 'out')
    return `[${f.handle}] ${f.entityHandle} — ${f.predicate} → ${clip(f.object, 160)}${since}`;
  if (f.edge === 'in')
    return `[${f.handle}] ${clip(f.object, 160)} — ${f.predicate} → ${f.entityHandle}${since}`;
  return `[${f.handle}] ${f.entityHandle} · ${f.predicate}: ${clip(f.object, 160)}${since}`;
}

export interface MemoryContext {
  /** ISO instant the current turn was said / occurred. */
  occurredAt?: string | undefined;
  /** Earlier turns of the same conversation, oldest first. */
  recentTurns: MemoryTurn[];
  entities: MemoryEntity[];
  facts: MemoryFact[];
  /** The tenant's own predicate vocabulary, most used first. */
  predicates: string[];
}

/** Prompt-side caps: enough to anchor a turn, small enough to stay cheap. */
export const MEMORY_RECENT_TURNS = 6;
export const MEMORY_FACTS_PER_ENTITY = 12;
export const MEMORY_EDGES_PER_ENTITY = 8;
export const MEMORY_PREDICATES = 40;
/** Characters of one earlier turn shown as context. */
const TURN_CHARS = 280;

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The user-message section that precedes the current turn. Returns ''
 * when the context holds nothing — the extractor input is then
 * byte-identical to a context-free call.
 */
export function renderMemoryContext(ctx: MemoryContext | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  const day = ctx.occurredAt?.slice(0, 10);
  if (day) {
    parts.push(
      `TURN DATE: ${day}\n` +
        `Resolve every relative or partial date in the turn against it ("19 сентября" → ${day.slice(0, 4)}-09-19, "next month", "yesterday").`,
    );
  }
  if (ctx.recentTurns.length > 0) {
    parts.push(
      'CONVERSATION SO FAR (earlier turns, oldest first — context for names, pronouns and references ONLY; extract facts from the CURRENT TURN alone):\n' +
        ctx.recentTurns
          .map(
            (t) =>
              `[${t.at.slice(0, 10)}] ${t.speaker ? `${t.speaker}: ` : ''}${clip(t.text, TURN_CHARS)}`,
          )
          .join('\n'),
    );
  }
  if (ctx.entities.length > 0) {
    parts.push(
      'KNOWN ENTITIES (already in memory — when a mention refers to one, set known to its handle):\n' +
        ctx.entities.map((e) => `[${e.handle}] ${e.name} (${e.type})`).join('\n'),
    );
  }
  if (ctx.facts.length > 0) {
    parts.push(
      "KNOWN FACTS and relations about them (when the current turn changes, updates or contradicts one, put its handle in the new fact's supersedes):\n" +
        ctx.facts.map(renderMemoryFact).join('\n'),
    );
  }
  if (ctx.predicates.length > 0) {
    parts.push(
      'KNOWN PREDICATES of this memory (reuse the same name for the same attribute; coin a new specific one only for an attribute none of these names):\n' +
        ctx.predicates.join(', '),
    );
  }
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n\nCURRENT TURN:\n`;
}

/**
 * A stable digest of everything the context can change in the
 * extraction — the cache key's memory partition. Two calls with the
 * same text but a different memory must not share a memoised result.
 */
export function memoryContextDigest(ctx: MemoryContext | undefined): string {
  if (!ctx) return '';
  return [
    ctx.occurredAt?.slice(0, 10) ?? '',
    ctx.recentTurns.map((t) => `${t.at}|${t.text.length}`).join(','),
    ctx.entities.map((e) => e.id).join(','),
    ctx.facts.map((f) => f.id).join(','),
    ctx.predicates.join(','),
  ].join('\n');
}

/** [e3] / e3 / E3 → e3; anything else → null. */
export function normalizeHandle(raw: unknown, kind: 'e' | 'm'): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^\[?\s*([em])\s*(\d+)\s*\]?$/i.exec(raw.trim());
  if (!m || m[1]!.toLowerCase() !== kind) return null;
  return `${kind}${Number(m[2])}`;
}

/** Map an entity handle the extractor returned to the record id it names. */
export function knownEntityId(ctx: MemoryContext | undefined, raw: unknown): string | undefined {
  const handle = normalizeHandle(raw, 'e');
  if (!handle || !ctx) return undefined;
  return ctx.entities.find((e) => e.handle === handle)?.id;
}

/** Map the fact handles the extractor returned to record ids, dropping the invented ones. */
export function supersededFactIds(ctx: MemoryContext | undefined, raw: unknown): string[] {
  if (!ctx || !Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    const handle = normalizeHandle(r, 'm');
    const id = handle ? ctx.facts.find((f) => f.handle === handle)?.id : undefined;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
