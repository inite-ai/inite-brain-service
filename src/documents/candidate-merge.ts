/**
 * Cross-indexer / cross-chunk candidate merging — the pure half of the
 * Brain's CommitMemory step.
 *
 * entityIndex references in candidate payloads are LOCAL to one
 * (run, chunk) extraction; this module re-keys entities globally by
 * (type, folded name), folds duplicate facts across indexers/chunks into
 * ONE merged fact each, and dedupes relations. Deterministic and I/O-free
 * — unit-testable without a DB or an LLM.
 *
 * Confidence on merge is MAX, not noisy-or: multiple indexers reading the
 * same document are NOT independent evidence (the same principle that
 * keys corroboration on originKey, migration 0050). Per-contributor
 * confidences survive in `contributors` for provenance.
 */
import type { CandidateRow } from './candidate-store.service';

export interface MergedEntity {
  key: string;
  name: string;
  type: string;
  canonical?: string;
  /** Leader first; the rest fold to status 'merged'. */
  candidateIds: string[];
}

export interface FactContributor {
  candidateId: string;
  indexerId: string;
  packVersion: string;
  model: string | null;
  confidence: number;
  chunkSeq: number;
}

export interface MergedFact {
  entityKey: string;
  predicate: string;
  object: string;
  /** max across contributors */
  confidence: number;
  entropy?: number;
  clause?: string;
  /** Leader's indexer — becomes the committed fact's source.recorder. */
  recorder: string;
  leaderId: string;
  leaderChunkSeq: number;
  mergedIds: string[];
  contributors: FactContributor[];
}

export interface MergedRelation {
  fromKey: string;
  toKey: string;
  kind: string;
  confidence: number;
  leaderId: string;
  mergedIds: string[];
}

export interface RejectedCandidate {
  candidateId: string;
  kind: 'entity' | 'fact' | 'relation';
  reason: string;
}

export interface MergeResult {
  entities: MergedEntity[];
  facts: MergedFact[];
  relations: MergedRelation[];
  rejected: RejectedCandidate[];
}

interface MergeContext {
  /** (run, chunk, entityIndex) → global entity key */
  scopeToKey: Map<string, string>;
  rejected: RejectedCandidate[];
}

export function mergeCandidates(rows: CandidateRow[]): MergeResult {
  const ctx: MergeContext = { scopeToKey: new Map(), rejected: [] };
  const entities = mergeEntities(rows, ctx);
  const facts = mergeFacts(rows, ctx);
  const relations = mergeRelations(rows, ctx);
  return { entities, facts, relations, rejected: ctx.rejected };
}

/** Entities: (run, chunk, entityIndex) → global (type, folded name) key. */
function mergeEntities(rows: CandidateRow[], ctx: MergeContext): MergedEntity[] {
  const entities = new Map<string, MergedEntity>();
  for (const row of rows) {
    if (row.kind !== 'entity') continue;
    const p = row.payload;
    if (typeof p.name !== 'string' || !p.name.trim()) {
      ctx.rejected.push({ candidateId: row.id, kind: 'entity', reason: 'malformed_entity' });
      continue;
    }
    const key = entityKeyOf(p.type, p.canonical ?? p.name);
    ctx.scopeToKey.set(scopeRef(row.runId, row.chunkSeq, p.entityIndex), key);
    const existing = entities.get(key);
    if (existing) {
      existing.candidateIds.push(row.id);
      // Prefer a canonical clue over none.
      if (!existing.canonical && p.canonical) existing.canonical = p.canonical;
    } else {
      entities.set(key, {
        key,
        name: p.name,
        type: normalizeType(p.type),
        canonical: p.canonical,
        candidateIds: [row.id],
      });
    }
  }
  return [...entities.values()];
}

/**
 * Facts: resolve the entity through the scope map, group by
 * (entityKey, predicate, normalized object).
 */
function mergeFacts(rows: CandidateRow[], ctx: MergeContext): MergedFact[] {
  const factGroups = new Map<string, MergedFact>();
  for (const row of rows) {
    if (row.kind !== 'fact') continue;
    const p = row.payload;
    const entityKey = ctx.scopeToKey.get(
      scopeRef(row.runId, row.chunkSeq, p.entityIndex),
    );
    if (!entityKey) {
      ctx.rejected.push({ candidateId: row.id, kind: 'fact', reason: 'orphan_entity' });
      continue;
    }
    if (typeof p.predicate !== 'string' || typeof p.object !== 'string') {
      ctx.rejected.push({ candidateId: row.id, kind: 'fact', reason: 'malformed_fact' });
      continue;
    }
    const groupKey = joinKey(entityKey, p.predicate, normalizeObject(p.object));
    foldFactIntoGroup({ factGroups, groupKey, entityKey, row });
  }
  return [...factGroups.values()];
}

function foldFactIntoGroup(p: {
  factGroups: Map<string, MergedFact>;
  groupKey: string;
  entityKey: string;
  row: CandidateRow;
}): void {
  const { row } = p;
  const payload = row.payload;
  const contributor: FactContributor = {
    candidateId: row.id,
    indexerId: String(payload.indexerId ?? 'core'),
    packVersion: String(payload.packVersion ?? '0'),
    model: payload.model ?? null,
    confidence: row.confidence,
    chunkSeq: row.chunkSeq,
  };
  const group = p.factGroups.get(p.groupKey);
  if (!group) {
    p.factGroups.set(p.groupKey, {
      entityKey: p.entityKey,
      predicate: payload.predicate,
      object: payload.object,
      confidence: row.confidence,
      entropy: numOrUndefined(payload.extractionEntropy),
      clause: payload.clause,
      recorder: contributor.indexerId,
      leaderId: row.id,
      leaderChunkSeq: row.chunkSeq,
      mergedIds: [],
      contributors: [contributor],
    });
    return;
  }
  group.contributors.push(contributor);
  if (row.confidence > group.confidence) {
    // New leader: previous leader folds to merged.
    group.mergedIds.push(group.leaderId);
    group.leaderId = row.id;
    group.leaderChunkSeq = row.chunkSeq;
    group.confidence = row.confidence;
    group.recorder = contributor.indexerId;
    group.entropy = numOrUndefined(payload.extractionEntropy);
    group.clause = payload.clause ?? group.clause;
  } else {
    group.mergedIds.push(row.id);
  }
}

/** Relations: resolve endpoints, dedupe by (from, to, kind). */
function mergeRelations(rows: CandidateRow[], ctx: MergeContext): MergedRelation[] {
  const relationGroups = new Map<string, MergedRelation>();
  for (const row of rows) {
    if (row.kind !== 'relation') continue;
    const p = row.payload;
    const fromKey = ctx.scopeToKey.get(
      scopeRef(row.runId, row.chunkSeq, p.fromEntityIndex),
    );
    const toKey = ctx.scopeToKey.get(
      scopeRef(row.runId, row.chunkSeq, p.toEntityIndex),
    );
    if (!fromKey || !toKey || fromKey === toKey) {
      ctx.rejected.push({ candidateId: row.id, kind: 'relation', reason: 'orphan_relation' });
      continue;
    }
    const groupKey = joinKey(fromKey, toKey, String(p.kind));
    const group = relationGroups.get(groupKey);
    if (!group) {
      relationGroups.set(groupKey, {
        fromKey,
        toKey,
        kind: String(p.kind),
        confidence: row.confidence,
        leaderId: row.id,
        mergedIds: [],
      });
    } else {
      group.confidence = Math.max(group.confidence, row.confidence);
      group.mergedIds.push(row.id);
    }
  }
  return [...relationGroups.values()];
}

/** "predicate: object" strings per entity — feeds the inline-resolution judge. */
export function incomingFactsFor(
  merge: MergeResult,
  entityKey: string,
): string[] {
  return merge.facts
    .filter((f) => f.entityKey === entityKey)
    .map((f) => `${f.predicate}: ${f.object}`);
}

function entityKeyOf(type: unknown, name: string): string {
  return joinKey(normalizeType(type), foldName(name));
}

function normalizeType(type: unknown): string {
  return typeof type === 'string' && type.trim() ? type.trim() : 'other';
}

function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeObject(object: string): string {
  return object.trim().replace(/\s+/g, ' ');
}

function scopeRef(runId: string, chunkSeq: number, entityIndex: unknown): string {
  return `${runId}\x00${chunkSeq}\x00${String(entityIndex)}`;
}

function joinKey(...parts: string[]): string {
  return parts.join('\x00');
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
