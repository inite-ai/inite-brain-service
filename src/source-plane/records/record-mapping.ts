import type { RecordEnvelope } from '../connector';

/**
 * The records door's contract (docs/roadmap/crm-sources-2026-09.md
 * § 4.1): how one record envelope becomes facts — deterministically,
 * with no model call. A MAPPING names, per entity type, which attribute
 * is which predicate; the door renders the record (the grounding
 * document, `key: value` lines, sorted) and submits candidates whose
 * every value appears verbatim in that render, so the external-
 * candidates grounding passes by construction.
 *
 * Bounded on purpose (doctrine 10): attribute key → predicate name, a
 * list of free-text keys, one lifecycle attribute, and a core entity
 * type per record type. No expressions, no paths, no scripting — a
 * vendor whose data needs more shapes it in its connector.
 */

/** The entity classes the pipeline knows (extractor-internals/types.ts). */
export type CoreEntityType =
  'customer' | 'staff' | 'asset' | 'project' | 'topic' | 'location' | 'other';

export interface EntityMapping {
  /** Attribute key → predicate: a pack `localId` (bare), or a core predicate name (`email`). */
  fields: Record<string, string>;
  /** Attribute keys whose value is prose: each becomes its own document for the extractor (budgeted). */
  text?: string[] | undefined;
  /** A lifecycle attribute: the pack's state model and the vendor value → declared state. */
  lifecycle?:
    { field: string; model: string; states?: Record<string, string> | undefined } | undefined;
  /** The core entity class the record's entity is filed under (default by type name). */
  coreType?: CoreEntityType | undefined;
}

/** Entity type → its mapping. */
export type RecordMapping = Record<string, EntityMapping>;

/** What the door may name — the pack's vocabulary and the core predicates an external indexer may seed. */
export interface Vocabulary {
  packId: string;
  localIds: ReadonlySet<string>;
  corePredicates: ReadonlySet<string>;
  /** stateModel id → declared states. */
  stateModels: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface MappedEntity {
  name: string;
  type: CoreEntityType;
  externalId: string;
}

export interface MappedFact {
  entityIndex: number;
  predicate: string;
  object: string;
}

export interface MappedRelation {
  fromEntityIndex: number;
  toEntityIndex: number;
  kind: string;
}

export type DropReason = 'unknown_predicate' | 'unknown_state' | 'unnamed_target';

export interface MappedRecord {
  /** The grounding document: the deterministic render. */
  text: string;
  /** [0] is the record itself; relation targets follow. */
  entities: MappedEntity[];
  facts: MappedFact[];
  relations: MappedRelation[];
  /** The lifecycle claim, when the mapping names one and the value maps to a declared state. */
  stateDelta: { model: string; to: string } | null;
  /** Prose attributes for the extractor, in mapping order. */
  textFields: Array<{ key: string; value: string }>;
  /** What the mapping named but the door could not honour — reported, never silent. */
  dropped: Array<{ key: string; reason: DropReason }>;
}

const DEFAULT_CORE_TYPE: Record<string, CoreEntityType> = {
  person: 'customer',
  contact: 'customer',
  lead: 'customer',
  organization: 'customer',
  company: 'customer',
  account: 'customer',
  deal: 'project',
  opportunity: 'project',
  ticket: 'project',
  task: 'project',
  user: 'staff',
  owner: 'staff',
  product: 'asset',
};

export function coreTypeOf(entityType: string, mapping?: EntityMapping): CoreEntityType {
  return mapping?.coreType ?? DEFAULT_CORE_TYPE[entityType.toLowerCase()] ?? 'other';
}

/**
 * Deterministic rendering of a record envelope — the same envelope
 * always yields the same text, so the document contentHash dedupes an
 * unchanged record and a changed attribute is a new document. Every
 * attribute value and every relation target name appears verbatim: the
 * grounding surface for the candidates `mapRecord` derives.
 */
export function renderRecord(r: RecordEnvelope): string {
  const lines = [`${r.entityType}: ${r.name}`, `id: ${r.externalId}`];
  for (const key of Object.keys(r.attributes).sort()) {
    const v = r.attributes[key];
    if (v === null || v === undefined || v === '') continue;
    lines.push(`${key}: ${String(v)}`);
  }
  for (const rel of r.relations ?? []) {
    lines.push(`${rel.kind}: ${rel.targetType} ${rel.targetName ?? rel.targetExternalId}`);
  }
  if (r.updatedAt) lines.push(`updated_at: ${r.updatedAt}`);
  return lines.join('\n');
}

/** The predicate a mapping value names, fully qualified — or null when the vocabulary has no such thing. */
export function resolvePredicate(named: string, vocab: Vocabulary): string | null {
  const sep = '__';
  if (named.includes(sep)) {
    const [pack, local] = [named.slice(0, named.indexOf(sep)), named.slice(named.indexOf(sep) + 2)];
    return pack === vocab.packId && vocab.localIds.has(local) ? named : null;
  }
  if (vocab.localIds.has(named)) return `${vocab.packId}${sep}${named}`;
  if (vocab.corePredicates.has(named)) return named;
  return null;
}

/**
 * One record → the candidates the door submits. `idScope` turns a
 * vendor id into the externalId the commit files the entity under
 * (scoped to the connection, so two CRM accounts' `#12` never merge).
 */
export function mapRecord(p: {
  record: RecordEnvelope;
  mapping: EntityMapping | undefined;
  vocab: Vocabulary;
  idScope: (entityType: string, externalId: string) => string;
}): MappedRecord {
  const { record, vocab } = p;
  const mapping = p.mapping ?? { fields: {} };
  const entities: MappedEntity[] = [
    {
      name: record.name,
      type: coreTypeOf(record.entityType, mapping),
      externalId: p.idScope(record.entityType, record.externalId),
    },
  ];
  const facts: MappedFact[] = [];
  const dropped: MappedRecord['dropped'] = [];
  const textKeys = new Set(mapping.text ?? []);
  for (const [key, named] of Object.entries(mapping.fields)) {
    const v = record.attributes[key];
    // An absent attribute is the normal case for a sparse record — not a drop.
    if (v === null || v === undefined || v === '') continue;
    const predicate = resolvePredicate(named, vocab);
    if (!predicate) {
      dropped.push({ key, reason: 'unknown_predicate' });
      continue;
    }
    facts.push({ entityIndex: 0, predicate, object: String(v) });
  }
  const relations: MappedRelation[] = [];
  for (const rel of record.relations ?? []) {
    if (!rel.targetName) {
      dropped.push({ key: rel.kind, reason: 'unnamed_target' });
      continue;
    }
    const index =
      entities.push({
        name: rel.targetName,
        type: coreTypeOf(rel.targetType),
        externalId: p.idScope(rel.targetType, rel.targetExternalId),
      }) - 1;
    relations.push({ fromEntityIndex: 0, toEntityIndex: index, kind: rel.kind });
  }
  let stateDelta: MappedRecord['stateDelta'] = null;
  if (mapping.lifecycle) {
    const raw = record.attributes[mapping.lifecycle.field];
    const states = vocab.stateModels.get(mapping.lifecycle.model);
    if (raw !== null && raw !== undefined && raw !== '' && states) {
      const to = mapping.lifecycle.states?.[String(raw)] ?? String(raw);
      if (states.has(to)) stateDelta = { model: mapping.lifecycle.model, to };
      else dropped.push({ key: mapping.lifecycle.field, reason: 'unknown_state' });
    }
  }
  const textFields: MappedRecord['textFields'] = [];
  for (const key of textKeys) {
    const v = record.attributes[key];
    if (typeof v === 'string' && v.trim().length > 0) textFields.push({ key, value: v });
  }
  return {
    text: renderRecord(record),
    entities,
    facts,
    relations,
    stateDelta,
    textFields,
    dropped,
  };
}

/** Merge a connection's own mapping over a connector's preset, per entity type. */
export function mergeMappings(
  preset: RecordMapping | undefined,
  own: RecordMapping | undefined,
): RecordMapping {
  const out: RecordMapping = {};
  for (const type of new Set([...Object.keys(preset ?? {}), ...Object.keys(own ?? {})])) {
    out[type] = mergeEntity(preset?.[type], own?.[type]);
  }
  return out;
}

function mergeEntity(a: EntityMapping | undefined, b: EntityMapping | undefined): EntityMapping {
  const merged: EntityMapping = { fields: { ...(a?.fields ?? {}), ...(b?.fields ?? {}) } };
  const text = b?.text ?? a?.text;
  const lifecycle = b?.lifecycle ?? a?.lifecycle;
  const coreType = b?.coreType ?? a?.coreType;
  if (text) merged.text = text;
  if (lifecycle) merged.lifecycle = lifecycle;
  if (coreType) merged.coreType = coreType;
  return merged;
}
