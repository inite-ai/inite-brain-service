import { createHash } from 'node:crypto';
import type {
  PackExtractionProfile,
  PiiClass,
  PredicateDefinition,
  PredicateStatus,
  Semantics,
} from './types';

/** Deterministic (recursively key-sorted) JSON — so the profile hash is stable
 *  regardless of manifest key order. Local copy to keep db-mapping dependency-free. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`;
}

/**
 * SurrealDB v2 SCHEMAFULL rejects JS null for `option<...>` fields with
 * "Found NULL, expected a option<...>". The expected representation is
 * NONE — achievable by OMITTING the field from the CREATE CONTENT
 * object entirely. Any field declared `option<...>` in migration 0011
 * (decayHalfLifeDays, requiresScope, parentPredicateId, subjectClasses,
 * allowedValues, aliasedTo) must be conditionally included.
 */
export function serializeForInsert(p: PredicateDefinition): Record<string, unknown> {
  return {
    predicateId: p.predicateId,
    displayLabel: p.displayLabel,
    description: p.description,
    datatype: p.datatype,
    semantics: p.semantics,
    ...(p.decayHalfLifeDays !== null && p.decayHalfLifeDays !== undefined
      ? { decayHalfLifeDays: p.decayHalfLifeDays }
      : {}),
    piiClass: p.piiClass,
    ...(p.requiresScope ? { requiresScope: p.requiresScope } : {}),
    ...(p.parentPredicateId ? { parentPredicateId: p.parentPredicateId } : {}),
    ...(p.subjectClasses ? { subjectClasses: p.subjectClasses } : {}),
    ...(p.allowedValues ? { allowedValues: p.allowedValues } : {}),
    status: p.status,
    ...(p.aliasedTo ? { aliasedTo: p.aliasedTo } : {}),
    createdBy: p.createdBy,
  };
}

export function deserializeFromRow(row: Record<string, unknown>): PredicateDefinition {
  return {
    predicateId: String(row.predicateId),
    displayLabel: String(row.displayLabel ?? row.predicateId),
    description: String(row.description ?? ''),
    datatype: (row.datatype as PredicateDefinition['datatype']) ?? 'string',
    semantics: row.semantics as Semantics,
    decayHalfLifeDays: typeof row.decayHalfLifeDays === 'number' ? row.decayHalfLifeDays : null,
    piiClass: row.piiClass as PiiClass,
    ...(row.requiresScope ? { requiresScope: String(row.requiresScope) } : {}),
    ...(row.parentPredicateId ? { parentPredicateId: String(row.parentPredicateId) } : {}),
    ...(Array.isArray(row.subjectClasses)
      ? { subjectClasses: row.subjectClasses as string[] }
      : {}),
    ...(Array.isArray(row.allowedValues) ? { allowedValues: row.allowedValues as string[] } : {}),
    status: (row.status as PredicateStatus) ?? 'active',
    ...(row.aliasedTo ? { aliasedTo: String(row.aliasedTo) } : {}),
    createdBy: (row.createdBy as PredicateDefinition['createdBy']) ?? 'system',
  };
}

/**
 * What we embed for similarity search: predicate id (lexical surface)
 * plus the description (semantic content). Description carries the
 * bulk of the signal — "preference: TYPE behavioral... ADMIT stable
 * taste..." matches "hobby: enjoys photography" much better than the
 * bare id "preference" alone.
 */
export function embeddingTextFor(p: PredicateDefinition): string {
  return `${p.predicateId.replace(/_/g, ' ')}: ${p.description}`;
}

/**
 * Stable hash of the extractor-relevant registry state. Pinned to extractor
 * traces (and used as the extractor cache's vocab key) so a downstream audit
 * can correlate an extraction with the exact state it was made against.
 *
 * Folds in the active-row-set AND the active extraction profiles: a pack
 * upgrade that edits only its extractionProfile (guidance / few-shot) leaves
 * every predicate row unchanged, so hashing rows alone would keep the same
 * versionHash and the extractor cache would serve extractions made against the
 * OLD profile. The profiles tune the prompt, so they belong in the key.
 */
export function computeHash(
  rows: PredicateDefinition[],
  extractionProfiles: PackExtractionProfile[] = [],
): string {
  const sorted = [...rows].sort((a, b) => a.predicateId.localeCompare(b.predicateId));
  const payload = sorted
    .map(
      (p) =>
        `${p.predicateId}|${p.semantics}|${p.decayHalfLifeDays}|${p.piiClass}|${p.requiresScope ?? ''}|${p.status}`,
    )
    .join('\n');
  const profilePayload = [...extractionProfiles]
    .sort((a, b) => a.packId.localeCompare(b.packId))
    .map((p) => `${p.packId}=${stableJson(p.profile)}`)
    .join('\n');
  return createHash('sha256')
    .update(`${payload}\n##profiles##\n${profilePayload}`)
    .digest('hex')
    .slice(0, 16);
}
