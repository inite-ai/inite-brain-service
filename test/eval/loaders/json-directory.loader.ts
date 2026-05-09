import { readFileSync } from 'node:fs';
import type {
  Scenario,
  SetupStep,
  QueryExpectation,
  MemoryAssertion,
} from '../types';

/**
 * JSON directory schema — the wire shape an operator hands the
 * loader. Designed to be hand-writable from a CRM export and
 * round-trippable through any JSON tool. Lifecycle ops (retract /
 * forget) are first-class; entities can declare them inline.
 *
 * Top-level:
 *   directoryName   — short tag, surfaces in scenario id
 *   description     — free-text, surfaces in the eval report
 *   entities        — flat list, each carries facts + optional retracts
 *   forgetEntities  — list of refs to GDPR-cascade after ingest
 *   queries         — optional retrieval expectations (recall@k checks)
 *   memoryAssertions — optional lifecycle assertions
 *
 * Shape decisions:
 *   - Each entity has its own list of facts. Predicates default to
 *     brain's vocabulary; the loader doesn't validate predicate names
 *     because operators can extend the vocabulary via env at the
 *     extractor level.
 *   - validFrom on a fact is REQUIRED. validUntil is optional;
 *     supersede chains are expressed by setting validUntil on the
 *     older fact and leaving the newer fact's validUntil unset.
 *   - Retracts live INSIDE the owning entity's `retract` array,
 *     referencing facts by their `tag`. Keeps the JSON local — an
 *     operator scrolling to "alice_smith" sees alice's full lifecycle
 *     in one block.
 *   - Forgets are SEPARATE because the cascade depends on every fact
 *     of the entity having been ingested first; the loader emits
 *     forget steps after all entities' facts.
 */
export interface JsonDirectoryFact {
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string;
  confidence?: number;
  source?: { vertical?: string; messageId?: string; eventId?: string };
  /** Handle for retract references; must be unique within the entity. */
  tag?: string;
}

export interface JsonDirectoryRetract {
  /** References a fact's tag declared on the same entity. */
  tag: string;
  reason: string;
}

export interface JsonDirectoryEntity {
  id: string;
  /** Optional override; defaults to the directoryName. */
  vertical?: string;
  facts: JsonDirectoryFact[];
  /** Retract operations local to this entity. */
  retract?: JsonDirectoryRetract[];
}

export interface JsonDirectoryForget {
  ref: string; // 'vertical.id' OR just 'id' (uses default vertical)
  reason: 'gdpr_request' | 'tenant_offboarding' | 'operator_request';
  requestId: string;
}

export interface JsonDirectory {
  directoryName: string;
  description?: string;
  entities: JsonDirectoryEntity[];
  forgetEntities?: JsonDirectoryForget[];
  queries?: QueryExpectation[];
  memoryAssertions?: MemoryAssertion[];
}

export interface LoadedDirectory {
  scenario: Scenario;
  stats: {
    entities: number;
    facts: number;
    retracts: number;
    forgets: number;
  };
}

/**
 * Read a JSON directory file and produce a Scenario the eval-runner
 * can consume directly. Throws with a clear, line-citing error on
 * any shape mismatch — operators editing JSON by hand will hit
 * mistakes; the message tells them WHERE.
 */
export function loadDirectoryJson(path: string): LoadedDirectory {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `[json-directory-loader] cannot read '${path}': ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[json-directory-loader] '${path}' is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseDirectory(parsed, path);
}

/**
 * Same as loadDirectoryJson but takes a parsed object — useful for
 * tests that don't want to write to disk.
 */
export function parseDirectoryObject(
  parsed: unknown,
  origin = '<inline>',
): LoadedDirectory {
  return parseDirectory(parsed, origin);
}

function parseDirectory(parsed: unknown, origin: string): LoadedDirectory {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `[json-directory-loader] '${origin}' top-level must be an object, got ${typeof parsed}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const directoryName = req<string>(obj, 'directoryName', origin, 'string');
  const description =
    typeof obj.description === 'string' ? obj.description : undefined;
  const entities = req<unknown[]>(obj, 'entities', origin, 'array');
  if (entities.length === 0) {
    throw new Error(
      `[json-directory-loader] '${origin}' has zero entities — nothing to load`,
    );
  }

  const setup: SetupStep[] = [];
  let factCount = 0;
  let retractCount = 0;

  for (const [eIdx, eRaw] of entities.entries()) {
    const trail = `${origin} > entities[${eIdx}]`;
    if (!eRaw || typeof eRaw !== 'object') {
      throw new Error(`[json-directory-loader] ${trail} must be an object`);
    }
    const e = eRaw as Record<string, unknown>;
    const id = req<string>(e, 'id', trail, 'string');
    const vertical =
      typeof e.vertical === 'string' && e.vertical.length > 0
        ? e.vertical
        : directoryName;
    const facts = req<unknown[]>(e, 'facts', trail, 'array');
    if (facts.length === 0) {
      throw new Error(
        `[json-directory-loader] ${trail} has zero facts — every entity needs at least one`,
      );
    }
    const tagsSeen = new Set<string>();
    for (const [fIdx, fRaw] of facts.entries()) {
      const fTrail = `${trail} > facts[${fIdx}]`;
      if (!fRaw || typeof fRaw !== 'object') {
        throw new Error(`[json-directory-loader] ${fTrail} must be an object`);
      }
      const f = fRaw as Record<string, unknown>;
      const predicate = req<string>(f, 'predicate', fTrail, 'string');
      const object = req<string>(f, 'object', fTrail, 'string');
      const validFrom = req<string>(f, 'validFrom', fTrail, 'string');
      const validUntil =
        typeof f.validUntil === 'string' ? f.validUntil : undefined;
      const confidence =
        typeof f.confidence === 'number' ? f.confidence : undefined;
      const tag = typeof f.tag === 'string' ? f.tag : undefined;
      if (tag) {
        if (tagsSeen.has(tag)) {
          throw new Error(
            `[json-directory-loader] ${fTrail}: duplicate tag '${tag}' within entity '${id}'`,
          );
        }
        tagsSeen.add(tag);
      }
      const sourceRaw = f.source as Record<string, unknown> | undefined;
      const source = {
        vertical:
          (sourceRaw &&
            typeof sourceRaw.vertical === 'string' &&
            sourceRaw.vertical) ||
          vertical,
        ...(sourceRaw?.messageId && typeof sourceRaw.messageId === 'string'
          ? { messageId: sourceRaw.messageId }
          : {}),
        ...(sourceRaw?.eventId && typeof sourceRaw.eventId === 'string'
          ? { eventId: sourceRaw.eventId }
          : {}),
      };
      setup.push({
        kind: 'fact',
        entityRef: { vertical, id },
        predicate,
        object,
        validFrom,
        validUntil,
        confidence,
        source,
        ...(tag ? { tag } : {}),
      });
      factCount++;
    }

    const retracts = Array.isArray(e.retract) ? (e.retract as unknown[]) : [];
    for (const [rIdx, rRaw] of retracts.entries()) {
      const rTrail = `${trail} > retract[${rIdx}]`;
      if (!rRaw || typeof rRaw !== 'object') {
        throw new Error(`[json-directory-loader] ${rTrail} must be an object`);
      }
      const r = rRaw as Record<string, unknown>;
      const tag = req<string>(r, 'tag', rTrail, 'string');
      const reason = req<string>(r, 'reason', rTrail, 'string');
      if (!tagsSeen.has(tag)) {
        throw new Error(
          `[json-directory-loader] ${rTrail}: tag '${tag}' references no fact on entity '${id}' (declared tags: ${[...tagsSeen].join(', ') || 'none'})`,
        );
      }
      setup.push({ kind: 'retract', tag, reason });
      retractCount++;
    }
  }

  const forgets = Array.isArray(obj.forgetEntities)
    ? (obj.forgetEntities as unknown[])
    : [];
  let forgetCount = 0;
  for (const [fIdx, fRaw] of forgets.entries()) {
    const fTrail = `${origin} > forgetEntities[${fIdx}]`;
    if (!fRaw || typeof fRaw !== 'object') {
      throw new Error(`[json-directory-loader] ${fTrail} must be an object`);
    }
    const f = fRaw as Record<string, unknown>;
    const ref = req<string>(f, 'ref', fTrail, 'string');
    const reason = req<string>(f, 'reason', fTrail, 'string');
    if (
      reason !== 'gdpr_request' &&
      reason !== 'tenant_offboarding' &&
      reason !== 'operator_request'
    ) {
      throw new Error(
        `[json-directory-loader] ${fTrail}: reason must be one of gdpr_request|tenant_offboarding|operator_request, got '${reason}'`,
      );
    }
    const requestId = req<string>(f, 'requestId', fTrail, 'string');
    const [vMaybe, idMaybe] = ref.split('.', 2);
    const entityRef = idMaybe
      ? { vertical: vMaybe, id: idMaybe }
      : { vertical: directoryName, id: vMaybe };
    setup.push({
      kind: 'forget',
      entityRef,
      reason,
      requestId,
    });
    forgetCount++;
  }

  const scenario: Scenario = {
    id: `directory.${directoryName}`,
    vertical: 'cross',
    description:
      description ??
      `Directory '${directoryName}': ${entities.length} entities, ${factCount} facts, ${retractCount} retracts, ${forgetCount} forgets.`,
    setup,
    queries: Array.isArray(obj.queries)
      ? (obj.queries as QueryExpectation[])
      : [],
    memoryAssertions: Array.isArray(obj.memoryAssertions)
      ? (obj.memoryAssertions as MemoryAssertion[])
      : undefined,
  };

  return {
    scenario,
    stats: {
      entities: entities.length,
      facts: factCount,
      retracts: retractCount,
      forgets: forgetCount,
    },
  };
}

/**
 * Required-field accessor with a uniform error shape. The expected
 * type is enforced at runtime AND announced in the error so an
 * operator with a mistyped field hits "expected string for `id`,
 * got number" instead of a downstream NaN cast.
 */
function req<T>(
  obj: Record<string, unknown>,
  key: string,
  trail: string,
  expected: 'string' | 'array' | 'object',
): T {
  const v = obj[key];
  if (v === undefined || v === null) {
    throw new Error(
      `[json-directory-loader] ${trail} missing required '${key}' (expected ${expected})`,
    );
  }
  if (expected === 'string' && typeof v !== 'string') {
    throw new Error(
      `[json-directory-loader] ${trail}.${key} must be a string, got ${typeof v}`,
    );
  }
  if (expected === 'array' && !Array.isArray(v)) {
    throw new Error(
      `[json-directory-loader] ${trail}.${key} must be an array, got ${typeof v}`,
    );
  }
  if (expected === 'object' && (typeof v !== 'object' || Array.isArray(v))) {
    throw new Error(
      `[json-directory-loader] ${trail}.${key} must be an object, got ${Array.isArray(v) ? 'array' : typeof v}`,
    );
  }
  return v as T;
}
