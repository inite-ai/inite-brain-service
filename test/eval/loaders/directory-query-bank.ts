import type { JsonDirectory, JsonDirectoryEntity } from './json-directory.loader';
import type { QueryExpectation, Scenario } from '../../../src/eval/types';

/**
 * Generate retrieval queries from a JsonDirectory. The Wikidata
 * fixtures (and operator-supplied JSON exports) ship with rich entity
 * facts but NO queries — without queries the directory is dead weight
 * for the recall@k / MRR / NDCG metrics.
 *
 * Per-entity strategy:
 *   1. Name lookup           — query="<name>", validates lexical+vector
 *                              fusion finds the canonical entity.
 *   2. Name+DOB cross-field  — query="<name> born <year>", validates
 *                              the predicate router routes to dob+name
 *                              and the merged ranker still picks the
 *                              right person among same-firstname noise.
 *   3. Name+location lookup  — query="<name> birthplace <city>",
 *                              validates address-predicate routing.
 *
 * Each query anchors on the entity's name so ground-truth stays
 * single-relevant — required by NDCG@10 (binary, IDCG=1) and recall@k.
 * Queries that would be ambiguous ("Russian poet born in Moscow" can
 * match dozens of people) are intentionally NOT generated.
 *
 * Sampling is seed-deterministic (mulberry32, default seed=42) so the
 * same fixture always produces the same query set across runs. This
 * is what makes baseline-tracking and delta-gates meaningful — without
 * it, "recall dropped 4pp" might just be the sampler picking different
 * entities.
 */

export interface QueryBankOptions {
  /**
   * Number of entities to sample. Capped at directory.entities.length.
   * Default 30 — chosen so a full quality-gate stays under ~5 minutes
   * on the standard runner; raise via env for thorough sweeps.
   */
  sampleEntities?: number;
  /** PRNG seed for reproducible sampling. Default 42. */
  seed?: number;
  /**
   * Vertical to assign the generated scenario. Default 'cross' so
   * Wikidata-driven queries don't pollute per-vertical thresholds for
   * rent / shop / etc.
   */
  vertical?: Scenario['vertical'];
  /** Cosmetic id suffix surfacing in the report. Default 'wikidata'. */
  scenarioIdSuffix?: string;
}

export interface QueryBankResult {
  /**
   * A scenario whose `setup` is the directory's full setup, and whose
   * `queries` are the generated query bank. Pass straight to EvalRunner.
   */
  scenario: Scenario;
  stats: {
    entitiesSeeded: number;
    entitiesSampled: number;
    queriesGenerated: number;
    skippedNameless: number;
  };
}

export function buildQueryBankFromDirectory(
  directory: JsonDirectory,
  baseScenario: Scenario,
  opts: QueryBankOptions = {},
): QueryBankResult {
  const sampleEntities = opts.sampleEntities ?? 30;
  const seed = opts.seed ?? 42;
  const vertical = opts.vertical ?? 'cross';
  const suffix = opts.scenarioIdSuffix ?? 'wikidata';

  const sampled = sampleDeterministic(directory.entities, sampleEntities, seed);
  const entityVerticalDefault = directory.directoryName;

  const queries: QueryExpectation[] = [];
  let skippedNameless = 0;
  for (const e of sampled) {
    const entityVertical = e.vertical ?? entityVerticalDefault;
    const ref = `${entityVertical}.${e.id}`;

    const name = pickFactObject(e, 'name');
    if (!name) {
      // Wikidata mapper drops nameless entities, but operator-supplied
      // JSON might not — be defensive and surface the count.
      skippedNameless++;
      continue;
    }

    // 1. Name lookup. Single-relevant by construction (no two entities
    //    share an exact-string name in a sane directory).
    queries.push({
      query: name,
      expectedTopEntityRef: ref,
      expectedFactPredicate: 'name',
    });

    // 2. Name + DOB year. Anchors on name (single-relevant), but the
    //    matched-fact assertion validates the dob predicate surfaced —
    //    this is what the predicate-router is supposed to do.
    const dob = pickFactObject(e, 'dob');
    if (dob && dob.length >= 4) {
      const year = dob.slice(0, 4);
      queries.push({
        query: `${name} born ${year}`,
        expectedTopEntityRef: ref,
        expectedFactPredicate: 'dob',
        // dob is PII — caller_scopes default already includes read_pii,
        // but we set it explicitly so the intent is grep-able.
        callerScopes: ['brain:read', 'brain:read_pii'],
      });
    }

    // 3. Name + birthplace. Wikidata stores birthplace under the
    //    address predicate ("birthplace: Kyiv"). Strip the prefix to
    //    form a natural-language query.
    const address = pickFactObject(e, 'address');
    if (address) {
      const place = address.replace(/^(birthplace|country|headquarters):\s*/i, '');
      if (place && place !== address) {
        queries.push({
          query: `${name} from ${place}`,
          expectedTopEntityRef: ref,
          expectedFactPredicate: 'address',
          callerScopes: ['brain:read', 'brain:read_pii'],
        });
      }
    }
  }

  const scenario: Scenario = {
    id: `${baseScenario.id}.${suffix}`,
    vertical,
    description: `${baseScenario.description} Augmented with ${queries.length} generated queries over ${sampled.length} sampled entities (seed=${seed}).`,
    setup: baseScenario.setup,
    queries,
  };

  return {
    scenario,
    stats: {
      entitiesSeeded: directory.entities.length,
      entitiesSampled: sampled.length,
      queriesGenerated: queries.length,
      skippedNameless,
    },
  };
}

/**
 * Same PRNG as fat-tenant.generator — mulberry32 with the provided
 * seed. Picks `n` entities without replacement using a partial
 * Fisher-Yates shuffle.
 */
function sampleDeterministic(
  entities: JsonDirectoryEntity[],
  n: number,
  seed: number,
): JsonDirectoryEntity[] {
  const k = Math.min(n, entities.length);
  if (k <= 0) return [];
  const arr = entities.slice();
  const rand = mulberry32(seed);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, k);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFactObject(entity: JsonDirectoryEntity, predicate: string): string | undefined {
  for (const f of entity.facts) {
    if (f.predicate === predicate) return f.object;
  }
  return undefined;
}
