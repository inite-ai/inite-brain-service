/**
 * The core entity types — the one list `knowledge_entity.type` may hold
 * (ASSERT in migration 0195), the extractor's closed enum, the records
 * door's `coreType` and the wire contract all read from here. A copy
 * anywhere else drifts: until 0195 four copies of the CRM-era list
 * existed, and a type one of them lacked was folded into `other` for good.
 *
 * `customer` and `staff` stay the ROLE types (a client of the business,
 * someone who works for it) — CRM packs and connectors keep filing people
 * under them. `person` and `organization` are for people and organisations
 * that memory knows without such a role (a general-memory client's family,
 * friends, employers), which used to land in `other` or be forced into a
 * role the text never stated. `document` is a named document, file or page
 * treated as a subject — the file-memory, web-memory and legal packs
 * declare predicates whose subject is one ("subject is a document/file").
 *
 * The order is the order the extractor reads; append, never reorder or
 * remove (a removed value would fail the ASSERT on rows already written).
 */
export const ENTITY_TYPES = [
  'customer',
  'staff',
  'person',
  'organization',
  'asset',
  'project',
  'document',
  'topic',
  'location',
  'other',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/** What each type means — rendered into the extractor prompt so the model picks by meaning, not by name. */
export const ENTITY_TYPE_GLOSS: Readonly<Record<EntityType, string>> = {
  customer:
    'a person or organisation the text places as a client / customer / lead of the business',
  staff: 'a person the text places as working for the business (employee, colleague, owner)',
  person: 'any other named person (family, friend, contact, public figure)',
  organization: 'any other named company, institution, team or group',
  asset: 'a product, system, service, code module, device or other owned thing',
  project: 'a deal, project, initiative, task or ticket',
  document: 'a named document, file, page, contract or message treated as a subject',
  topic: 'an abstract subject or theme',
  location: 'a named place (city, country, address, venue)',
  other: 'none of the above',
};

/**
 * Person-shaped types: what "a person's own history" means wherever a
 * subject's kind matters (fact-resolver's non-person slot guard). The
 * role types are people too, and the speaker is one of these.
 */
export const PERSON_ENTITY_TYPES: ReadonlySet<string> = new Set<EntityType>([
  'customer',
  'staff',
  'person',
]);

/** Longest raw type kept on `typeRaw` — a label, never a paragraph. */
const TYPE_RAW_MAX = 64;

const KNOWN: ReadonlySet<string> = new Set(ENTITY_TYPES);

export function isEntityType(t: unknown): t is EntityType {
  return typeof t === 'string' && KNOWN.has(t);
}

/**
 * Fold a type as an extractor, an indexer or a caller wrote it onto the
 * core list: exact or case/space-insensitive matches keep their type,
 * anything else is `other`. Use `classifyEntityType` where the original
 * must survive.
 */
export function normalizeEntityType(t: unknown): EntityType {
  return classifyEntityType(t).type;
}

/**
 * The core type plus, when it differs from what was written, the
 * original (`typeRaw`, trimmed and capped) — so an extraction that said
 * "vendor" or "Person" keeps saying so on the entity even though the
 * type column holds `other` or `person`. Absent when nothing was written
 * or the written value already is the core type.
 */
export function classifyEntityType(t: unknown): { type: EntityType; typeRaw?: string } {
  if (typeof t !== 'string') return { type: 'other' };
  const raw = t.trim().slice(0, TYPE_RAW_MAX);
  if (!raw) return { type: 'other' };
  if (KNOWN.has(raw)) return { type: raw as EntityType };
  const folded = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const type = KNOWN.has(folded) ? (folded as EntityType) : 'other';
  return { type, typeRaw: raw };
}

/**
 * The `type` / `typeRaw` pair an entity is CREATED with: the core type of
 * what was written, and the original when the two differ — either the one
 * an upstream normaliser already set aside (`typeRaw`, from the extractor
 * or the candidate pipeline) or the written value itself when it is not a
 * core type. No `typeRaw` key at all when they agree, so those rows are
 * byte-identical to the pre-0195 shape.
 */
export function entityTypeFields(
  written: unknown,
  typeRaw?: string,
): { type: EntityType; typeRaw?: string } {
  const c = classifyEntityType(written);
  const raw = typeRaw?.trim().slice(0, TYPE_RAW_MAX) || c.typeRaw;
  return raw && raw !== c.type ? { type: c.type, typeRaw: raw } : { type: c.type };
}
