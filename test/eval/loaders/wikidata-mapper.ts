import type { JsonDirectory, JsonDirectoryEntity, JsonDirectoryFact } from './json-directory.loader';

/**
 * Wikidata SPARQL → JsonDirectory mapper. Pure functions only — no
 * network, no FS. The CLI fetcher (scripts/fetch-wikidata-directory.ts)
 * does the SPARQL round-trip and feeds raw bindings here.
 *
 * Why pure mapper:
 *   - Unit-testable against fixture bindings without hitting the
 *     Wikidata endpoint.
 *   - Lets operators with their own SPARQL queries reuse the
 *     binding→fact mapping without rewriting it.
 *   - Templates declare expected variable names; mapping is
 *     mechanical from there.
 *
 * Property mapping decisions:
 *   - `?itemLabel`     → predicate=name (one fact per entity)
 *   - `?dob`           → predicate=dob (PII; gated by brain:read_pii)
 *   - `?birthPlaceLabel` → predicate=address (PII; gated)
 *   - `?occupationLabel` → predicate=interacted_with, object="occupation: <label>"
 *   - `?awardLabel`     → predicate=interacted_with, object="received <label>"
 *   - `?employerLabel`  → predicate=interacted_with, object="employed by <label>"
 *   - `?genreLabel`     → predicate=preference, object="genre: <label>"
 *   - `?countryLabel`   → predicate=address, object="country: <label>" (PII)
 *
 * Multi-valued properties (occupations, awards, genres) yield one
 * fact per distinct value. Wikidata returns one row per cross-product,
 * so we group by entity Q-id and dedupe object strings within
 * predicate.
 *
 * Entities without a name (rare but happens for stubs) are dropped.
 * The caller sees `stats.skippedEntities` so coverage misses surface.
 */

export interface WikidataTemplate {
  /** SPARQL query body. `$LIMIT` is replaced by the caller. */
  sparql: string;
  /** Used as JsonDirectory.directoryName. Lowercase, snake-case. */
  directoryName: string;
  description: string;
}

export const WIKIDATA_TEMPLATES: Record<string, WikidataTemplate> = {
  'russian-writers': {
    directoryName: 'wd_russian_writers',
    description:
      'Wikidata: writers (Q36180) whose works are in Russian (Q7737). Realistic stress-test for Cyrillic / Latin name aliasing, partial bibliographies, sparse attribute coverage.',
    sparql: `
SELECT DISTINCT ?item ?itemLabel ?dob ?birthPlaceLabel ?occupationLabel ?genreLabel WHERE {
  ?item wdt:P31 wd:Q5;
        wdt:P106 wd:Q36180;
        wdt:P1412 wd:Q7737.
  OPTIONAL { ?item wdt:P569 ?dob. }
  OPTIONAL { ?item wdt:P19 ?birthPlace. }
  OPTIONAL { ?item wdt:P106 ?occupation. FILTER (?occupation != wd:Q36180) }
  OPTIONAL { ?item wdt:P136 ?genre. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en,ru". }
}
LIMIT $LIMIT
    `.trim(),
  },
  'nobel-laureates-literature': {
    directoryName: 'wd_nobel_literature',
    description:
      'Wikidata: humans (Q5) who received the Nobel Prize in Literature (Q37922). Multi-locale names, well-attested aliases, dense biographical data — stresses cross-language search.',
    sparql: `
SELECT DISTINCT ?item ?itemLabel ?dob ?birthPlaceLabel ?countryLabel ?occupationLabel WHERE {
  ?item wdt:P31 wd:Q5;
        wdt:P166 wd:Q37922.
  OPTIONAL { ?item wdt:P569 ?dob. }
  OPTIONAL { ?item wdt:P19 ?birthPlace. }
  OPTIONAL { ?item wdt:P27 ?country. }
  OPTIONAL { ?item wdt:P106 ?occupation. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en,ru". }
}
LIMIT $LIMIT
    `.trim(),
  },
  'tech-companies-us': {
    directoryName: 'wd_tech_companies_us',
    description:
      'Wikidata: software companies (subclass of Q1058914) headquartered in the US (Q30). Realistic shape for B2B-CRM-style search — multi-word names, locations, founding dates.',
    sparql: `
SELECT DISTINCT ?item ?itemLabel ?inception ?hqLabel ?founderLabel WHERE {
  ?item wdt:P31/wdt:P279* wd:Q1058914;
        wdt:P17 wd:Q30.
  OPTIONAL { ?item wdt:P571 ?inception. }
  OPTIONAL { ?item wdt:P159 ?hq. }
  OPTIONAL { ?item wdt:P112 ?founder. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en,ru". }
}
LIMIT $LIMIT
    `.trim(),
  },
};

/**
 * Shape of one binding row from Wikidata Query Service. `xml:lang`
 * is preserved on label fields when available, but the mapper
 * doesn't depend on it — language tags are noise for our pipeline.
 */
export interface WikidataBindingValue {
  type: string;
  value: string;
  'xml:lang'?: string;
}
export type WikidataBinding = Record<string, WikidataBindingValue | undefined>;

export interface MapperStats {
  rawBindings: number;
  uniqueEntities: number;
  skippedEntities: number;
  emittedFacts: number;
}

export interface MapperOutput {
  directory: JsonDirectory;
  stats: MapperStats;
}

export function mapWikidataBindings(
  bindings: WikidataBinding[],
  template: WikidataTemplate,
): MapperOutput {
  // Group by Q-id. Wikidata yields one row per cross-product of
  // OPTIONAL multi-valued properties (occupations × genres × …),
  // so a single entity can occupy 10+ rows.
  const byEntity = new Map<string, WikidataBinding[]>();
  for (const b of bindings) {
    const itemUri = b.item?.value;
    if (!itemUri) continue;
    const qid = itemUri.split('/').pop();
    if (!qid) continue;
    if (!byEntity.has(qid)) byEntity.set(qid, []);
    byEntity.get(qid)!.push(b);
  }

  const entities: JsonDirectoryEntity[] = [];
  let skipped = 0;
  let emittedFacts = 0;

  // Fixed validFrom — these are reference data, not events; the
  // exact date doesn't matter as long as it's stable for repro.
  const validFrom = '2026-01-01T00:00:00Z';

  for (const [qid, rows] of byEntity) {
    // Lowercase the Q-id for the entity ref id — keeps our
    // externalRef tag clean (qid lowercase is canonical in our
    // ingest, plus Surreal record ids are case-sensitive).
    const id = qid.toLowerCase();

    const name = firstString(rows, 'itemLabel');
    if (!name) {
      skipped++;
      continue;
    }

    const facts: JsonDirectoryFact[] = [];
    facts.push({
      predicate: 'name',
      object: name,
      validFrom,
      confidence: 0.95,
    });

    const dob = firstString(rows, 'dob');
    if (dob) {
      // Wikidata serializes dates as ISO datetime; trim to
      // YYYY-MM-DD for human-readability of the fact object.
      const dobObj = dob.length >= 10 ? dob.slice(0, 10) : dob;
      facts.push({
        predicate: 'dob',
        object: dobObj,
        validFrom,
        confidence: 0.95,
      });
    }

    const birthPlace = firstString(rows, 'birthPlaceLabel');
    if (birthPlace) {
      facts.push({
        predicate: 'address',
        object: `birthplace: ${birthPlace}`,
        validFrom,
        confidence: 0.9,
      });
    }

    const country = firstString(rows, 'countryLabel');
    if (country) {
      facts.push({
        predicate: 'address',
        object: `country: ${country}`,
        validFrom,
        confidence: 0.9,
      });
    }

    const hq = firstString(rows, 'hqLabel');
    if (hq) {
      facts.push({
        predicate: 'address',
        object: `headquarters: ${hq}`,
        validFrom,
        confidence: 0.9,
      });
    }

    const inception = firstString(rows, 'inception');
    if (inception) {
      const inObj = inception.length >= 10 ? inception.slice(0, 10) : inception;
      facts.push({
        predicate: 'interacted_with',
        object: `founded ${inObj}`,
        validFrom,
        confidence: 0.9,
      });
    }

    // Multi-valued properties — collect distinct labels across all
    // rows for this entity, then emit one fact each.
    addDistinctMulti(rows, 'occupationLabel', facts, validFrom, (label) => ({
      predicate: 'interacted_with',
      object: `occupation: ${label}`,
      confidence: 0.85,
    }));
    addDistinctMulti(rows, 'genreLabel', facts, validFrom, (label) => ({
      predicate: 'preference',
      object: `genre: ${label}`,
      confidence: 0.8,
    }));
    addDistinctMulti(rows, 'founderLabel', facts, validFrom, (label) => ({
      predicate: 'interacted_with',
      object: `founded by ${label}`,
      confidence: 0.9,
    }));

    emittedFacts += facts.length;
    entities.push({ id, facts });
  }

  return {
    directory: {
      directoryName: template.directoryName,
      description: template.description,
      entities,
    },
    stats: {
      rawBindings: bindings.length,
      uniqueEntities: byEntity.size,
      skippedEntities: skipped,
      emittedFacts,
    },
  };
}

function firstString(
  rows: WikidataBinding[],
  key: string,
): string | undefined {
  for (const r of rows) {
    const v = r[key]?.value;
    if (v) return v;
  }
  return undefined;
}

function addDistinctMulti(
  rows: WikidataBinding[],
  key: string,
  facts: JsonDirectoryFact[],
  validFrom: string,
  build: (label: string) => Pick<JsonDirectoryFact, 'predicate' | 'object' | 'confidence'>,
): void {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[key]?.value;
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    facts.push({ ...build(v), validFrom });
  }
}
