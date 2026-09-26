/**
 * Several captured documents read by ONE extraction call.
 *
 * A turn of a conversation is a document of its own, and reading each on
 * its own paid the whole extraction prompt — instructions, vocabulary,
 * the memory around it, and the self-consistency passes over all of it —
 * for a sentence. Documents waiting for extraction are grouped instead:
 * one user scope, one conversation, oldest first, up to a size budget.
 * The group is rendered as CURRENT TURNS under headers, read once, and the
 * result is filed back under the document each claim was copied from: a
 * fact's clause (verbatim from the input, extractor contract) sits inside
 * exactly one turn's text.
 *
 * Pure module — no DB, no LLM.
 */
import { isGroundedSpan, normalizeForGrounding } from '../ai/extractor-internals/grounding';
import type { TurnHeader } from '../ai/extractor-internals/prompts';
import type {
  ExtractedEdge,
  ExtractedEntity,
  ExtractedFact,
  ExtractionResult,
} from '../ai/extractor-internals/types';

export interface GroupDoc {
  id: string;
  text: string;
  occurredAt: Date;
  chunkCount: number;
  userId?: string | undefined;
  /** The conversation the document is a turn of; absent = a standalone document. */
  conversationId?: string | undefined;
  speakerName?: string | undefined;
  speakerIsUser?: boolean | undefined;
  addresseeName?: string | undefined;
}

export interface GroupBudget {
  /** Characters of document text one call reads. */
  maxChars: number;
  /** Documents one call reads. */
  maxDocs: number;
}

/**
 * Partition documents into extraction groups. A group is the turns of ONE
 * conversation of one user scope, read together, in order, up to the
 * budget. A standalone document (no conversation), one cut into several
 * chunks, or one larger than the budget is read alone, chunk by chunk.
 */
export function planExtractionGroups(docs: GroupDoc[], budget: GroupBudget): GroupDoc[][] {
  const byKey = new Map<string, GroupDoc[]>();
  for (const d of [...docs].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const key = `${d.userId ?? ''}\x1e${d.conversationId ?? ''}`;
    const list = byKey.get(key) ?? [];
    list.push(d);
    byKey.set(key, list);
  }
  const groups: GroupDoc[][] = [];
  for (const list of byKey.values()) {
    let current: GroupDoc[] = [];
    let chars = 0;
    const flush = (): void => {
      if (current.length > 0) groups.push(current);
      current = [];
      chars = 0;
    };
    for (const d of list) {
      // Only the turns of one conversation are one text: several
      // standalone documents read in one call lose facts to each other
      // (measured on the dogfood battery — 8 unrelated notes in one read
      // dropped one document's decision and swapped another's number).
      if (!d.conversationId || d.chunkCount > 1 || d.text.length > budget.maxChars) {
        flush();
        groups.push([d]);
        continue;
      }
      if (current.length >= budget.maxDocs || chars + d.text.length > budget.maxChars) flush();
      current.push(d);
      chars += d.text.length;
    }
    flush();
  }
  return groups;
}

export interface RenderedGroup {
  /** The extractor input: every turn under its header, oldest first. */
  text: string;
  turns: TurnHeader[];
}

/** Render a group as CURRENT TURNS — each document's text under its header. */
export function renderGroup(docs: GroupDoc[]): RenderedGroup {
  const turns: TurnHeader[] = [];
  const blocks = docs.map((d, i) => {
    const label = `#${i + 1}`;
    const who = d.speakerName ?? 'document';
    turns.push({
      label,
      speakerName: d.speakerName,
      speakerIsUser: d.speakerIsUser,
      addresseeName: d.addresseeName,
    });
    return `[${label} · ${d.occurredAt.toISOString().slice(0, 10)} · ${who}]\n${d.text.trim()}`;
  });
  return { text: blocks.join('\n\n'), turns };
}

/**
 * File a group's extraction under the documents it came from. A fact or a
 * relation belongs to the document whose text holds its clause (else its
 * value, else the names it links); when the same words appear in several
 * turns, the latest one said them last. Each document gets the entities
 * its claims use, re-indexed, plus the claim-less entities its text names.
 */
export function splitGroupResult(docs: GroupDoc[], result: ExtractionResult): ExtractionResult[] {
  const texts = docs.map((d) => normalizeForGrounding(d.text));
  const locate = (...spans: Array<string | undefined>): number => {
    for (const span of spans) {
      if (!span?.trim()) continue;
      const n = normalizeForGrounding(span);
      for (let i = texts.length - 1; i >= 0; i -= 1) {
        if (isGroundedSpan(texts[i] as string, n)) return i;
      }
    }
    return -1;
  };
  const last = docs.length - 1;
  const factDoc = result.facts.map((f) => {
    const at = locate(f.clause, f.valueSpan, f.object, result.entities[f.entityIndex]?.name);
    return at < 0 ? last : at;
  });
  const edgeDoc = result.edges.map((e) => {
    const at = locate(
      e.clause,
      result.entities[e.toEntityIndex]?.name,
      result.entities[e.fromEntityIndex]?.name,
    );
    return at < 0 ? last : at;
  });
  const used = new Set<number>([
    ...result.facts.map((f) => f.entityIndex),
    ...result.edges.flatMap((e) => [e.fromEntityIndex, e.toEntityIndex]),
  ]);

  return docs.map((_, docIndex) => {
    const facts = result.facts.filter((_, i) => factDoc[i] === docIndex);
    const edges = result.edges.filter((_, i) => edgeDoc[i] === docIndex);
    const wanted = new Set<number>([
      ...facts.map((f) => f.entityIndex),
      ...edges.flatMap((e) => [e.fromEntityIndex, e.toEntityIndex]),
    ]);
    result.entities.forEach((e, i) => {
      if (!used.has(i) && locate(e.name) === docIndex) wanted.add(i);
    });
    const order = [...wanted].sort((a, b) => a - b);
    const remap = new Map(order.map((from, to) => [from, to]));
    const entities: ExtractedEntity[] = order.map((i) => result.entities[i] as ExtractedEntity);
    return {
      entities,
      facts: facts.map((f): ExtractedFact => ({
        ...f,
        entityIndex: remap.get(f.entityIndex) as number,
      })),
      edges: edges.map((e): ExtractedEdge => ({
        ...e,
        fromEntityIndex: remap.get(e.fromEntityIndex) as number,
        toEntityIndex: remap.get(e.toEntityIndex) as number,
      })),
    };
  });
}

/** Output allowance for a group: one turn's worth per turn read, bounded. */
export function groupVisibleCap(docCount: number): number {
  return Math.min(1500 * Math.max(1, docCount), 12_000);
}
