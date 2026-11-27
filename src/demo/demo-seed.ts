import { StringRecordId, type Surreal } from 'surrealdb';
import { nameKeysFor } from '../common/name-key';
import { createEdgeBetween } from '../ingest/edge-writer';
import { ATLANTICA_DEMO_PACK, type DemoFact, type DemoPack } from './atlantica-pack';
import { DEMO_ORG_ID, isDemoCompanyId } from './demo-tenant';

/**
 * The demo seed: writes the demo pack (atlantica-pack.ts) into the ONE
 * demo tenant, `co_<DEMO_ORG_ID>`, and nowhere else.
 *
 * No model call, on purpose and by construction: entities, facts and
 * edges are written as rows with fixed ids, so nothing is extracted,
 * embedded or judged. The rows carry no embedding; the demo workspace
 * reads them through the graph (graph_retrieve) and plain table reads,
 * never through vector search.
 *
 * Idempotent: every row has a deterministic id (`demo_<key>`), entities
 * and facts are UPSERTed, and edges go through the one edge-write
 * primitive, which is unique on (in, out, kind, scope). A second run
 * changes nothing a first run wrote; it only writes what a newer pack
 * version added.
 *
 * Dry run unless both the `--apply` argument and `DEMO_SEED_WRITE=1` are
 * given (demo-seed.cli.ts), and a tenant other than DEMO_ORG_ID is
 * refused before any connection is opened.
 */

/** The seed's provenance stamp on every fact and edge it writes. */
export const DEMO_SEED_RECORDER = 'brain-demo-seed';

export class NotDemoTenantError extends Error {
  constructor(companyId: string) {
    super(`refusing to seed tenant '${companyId}': the demo seed writes only to ${DEMO_ORG_ID}`);
    this.name = 'NotDemoTenantError';
  }
}

/** Throws unless `companyId` is the demo tenant. */
export function assertDemoTenant(companyId: string | null | undefined): string {
  if (!companyId || !isDemoCompanyId(companyId)) throw new NotDemoTenantError(String(companyId));
  return companyId;
}

export const entityRecordId = (key: string): string => `knowledge_entity:demo_${key}`;
export const factRecordId = (key: string): string => `knowledge_fact:demo_${key}`;
export const sourceRef = (key: string): string => `demo:${key}`;

export interface SeedSummary {
  tenant: string;
  pack: string;
  version: number;
  entities: number;
  facts: number;
  edges: number;
  sources: number;
}

export interface SeedArgs {
  apply: boolean;
  tenant: string;
}

/**
 * `--apply` and `DEMO_SEED_WRITE=1` together write; anything less is a dry
 * run. `--tenant <id>` (default DEMO_ORG_ID) must be the demo tenant.
 */
export function parseSeedArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SeedArgs {
  const i = argv.indexOf('--tenant');
  const fromEq = argv.find((a) => a.startsWith('--tenant='))?.slice('--tenant='.length);
  const tenant = fromEq ?? (i !== -1 ? argv[i + 1] : undefined) ?? DEMO_ORG_ID;
  return { apply: argv.includes('--apply') && env.DEMO_SEED_WRITE === '1', tenant };
}

/**
 * Check the pack is whole before anything is written: every fact, edge
 * and source reference names something the pack declares.
 */
export function validateDemoPack(pack: DemoPack): string[] {
  const problems: string[] = [];
  const entities = new Set(pack.entities.map((e) => e.key));
  const sources = new Set(pack.sources.map((s) => s.key));
  const factKeys = new Set<string>();
  for (const f of pack.facts) {
    if (factKeys.has(f.key)) problems.push(`fact ${f.key}: duplicate key`);
    factKeys.add(f.key);
    if (!entities.has(f.entity)) problems.push(`fact ${f.key}: unknown entity ${f.entity}`);
    if (!sources.has(f.source)) problems.push(`fact ${f.key}: unknown source ${f.source}`);
    if (f.validUntil && Date.parse(f.validUntil) <= Date.parse(f.validFrom)) {
      problems.push(`fact ${f.key}: validUntil is not after validFrom`);
    }
  }
  for (const e of pack.edges) {
    if (!entities.has(e.from) || !entities.has(e.to)) {
      problems.push(`edge ${e.from}-${e.kind}-${e.to}: unknown entity`);
    }
    if (!sources.has(e.source)) problems.push(`edge ${e.from}-${e.kind}-${e.to}: unknown source`);
  }
  return problems;
}

export function summarize(pack: DemoPack, tenant: string): SeedSummary {
  return {
    tenant,
    pack: pack.id,
    version: pack.version,
    entities: pack.entities.length,
    facts: pack.facts.length,
    edges: pack.edges.length,
    sources: pack.sources.length,
  };
}

function factSource(pack: DemoPack, f: { source: string }): Record<string, unknown> {
  const src = pack.sources.find((s) => s.key === f.source);
  return {
    vertical: 'demo',
    recorder: DEMO_SEED_RECORDER,
    evidence: [{ kind: src?.kind ?? 'other', ref: sourceRef(f.source), note: src?.title ?? '' }],
  };
}

/** The fact that replaced `f` in the same slot, when the pack holds one. */
function successorOf(pack: DemoPack, f: DemoFact): DemoFact | undefined {
  if (!f.validUntil) return undefined;
  return pack.facts.find(
    (g) =>
      g.key !== f.key &&
      g.entity === f.entity &&
      g.predicate === f.predicate &&
      Date.parse(g.validFrom) === Date.parse(f.validUntil as string),
  );
}

async function upsertEntities(db: Surreal, pack: DemoPack): Promise<void> {
  for (const e of pack.entities) {
    const aliases = e.aliases ?? [];
    await db.query(`UPSERT $id MERGE $content`, {
      id: new StringRecordId(entityRecordId(e.key)),
      content: {
        type: e.type,
        canonicalName: e.name,
        aliases,
        nameKeys: nameKeysFor([e.name, ...aliases]),
        externalRefs: { demo: e.key },
      },
    });
  }
}

async function upsertFacts(db: Surreal, pack: DemoPack): Promise<void> {
  for (const f of pack.facts) {
    const next = successorOf(pack, f);
    await db.query(`UPSERT $id MERGE $content`, {
      id: new StringRecordId(factRecordId(f.key)),
      content: {
        entityId: new StringRecordId(entityRecordId(f.entity)),
        predicate: f.predicate,
        object: f.object,
        confidence: f.confidence,
        validFrom: new Date(f.validFrom),
        ...(f.validUntil ? { validUntil: new Date(f.validUntil) } : {}),
        source: factSource(pack, f),
        status: next ? 'superseded' : 'active',
        ...(next
          ? {
              retractionReason: 'superseded',
              retractedBy: 'system',
              supersededBy: new StringRecordId(factRecordId(next.key)),
            }
          : {}),
        lang: 'en',
      },
    });
  }
}

async function writeEdges(db: Surreal, pack: DemoPack): Promise<void> {
  for (const e of pack.edges) {
    await createEdgeBetween(db, {
      fromEntityId: entityRecordId(e.from),
      toEntityId: entityRecordId(e.to),
      kind: e.kind,
      source: factSource(pack, e),
      validFrom: new Date(e.validFrom),
    });
  }
}

/**
 * Write the pack into an open connection to the demo tenant. The caller
 * opened `db` through `SurrealService.withCompany(assertDemoTenant(id))`.
 */
export async function applyDemoSeed(
  db: Surreal,
  tenant: string,
  pack: DemoPack = ATLANTICA_DEMO_PACK,
): Promise<SeedSummary> {
  assertDemoTenant(tenant);
  const problems = validateDemoPack(pack);
  if (problems.length > 0) throw new Error(`demo pack is not whole: ${problems.join('; ')}`);
  await upsertEntities(db, pack);
  await upsertFacts(db, pack);
  await writeEdges(db, pack);
  return summarize(pack, tenant);
}
