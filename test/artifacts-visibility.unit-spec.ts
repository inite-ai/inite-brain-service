/**
 * Artifacts × caller visibility. The compiled dossier is cached in ONE
 * knowledge_artifact slot per (entity, type); before, an artifact built
 * for a brain:read_pii caller was served to a brain:read caller until it
 * went stale, risk_snapshot listed facts of any predicate unfiltered,
 * and sourceFactIds named gated facts. Pins: the cache is served only to
 * the visibility it was built for, the registry policy (tenant-authored
 * requiresScope) gates compile and read, list items are filtered by
 * their own predicate, and sourceFactIds follow the surviving citations.
 */
import { ArtifactsService } from '../src/artifacts/artifacts.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { BrainScope } from '../src/auth/api-key.types';

type Row = Record<string, unknown>;

const FACTS: Row[] = [
  {
    id: 'knowledge_fact:n',
    predicate: 'name',
    object: 'Ada',
    confidence: 0.9,
    validFrom: '2026-01-01',
    recordedAt: '2026-01-02T00:00:00Z',
    source: { vertical: 'x' },
    status: 'competing',
  },
  {
    id: 'knowledge_fact:d',
    predicate: 'dob',
    object: '1990-01-01',
    confidence: 0.9,
    validFrom: '2026-01-01',
    recordedAt: '2026-01-03T00:00:00Z',
    source: { vertical: 'x' },
    status: 'competing',
  },
  {
    id: 'knowledge_fact:s',
    predicate: 'salary_band',
    object: 'L7',
    confidence: 0.3,
    validFrom: '2026-01-01',
    recordedAt: '2026-01-04T00:00:00Z',
    source: { vertical: 'x' },
    status: 'active',
  },
];

/** A fake tenant DB holding one artifact slot, like the UNIQUE index. */
function harness() {
  let slot: Row | undefined;
  const sqls: string[] = [];
  const db = {
    query: async (sql: string, params: Record<string, unknown> = {}) => {
      sqls.push(sql);
      if (sql.includes('FROM type::record')) return [[{ id: 'knowledge_entity:e1' }]];
      if (sql.includes('FROM knowledge_artifact')) return [slot ? [slot] : []];
      if (sql.includes('FROM knowledge_fact')) return [FACTS];
      if (sql.startsWith('UPDATE knowledge_artifact')) {
        if (!slot) return [[]];
        slot = {
          ...slot,
          payload: params.wrapped,
          sourceFactIds: (params.facts as Array<{ toString(): string }>).map(String),
          builtAt: new Date().toISOString(),
          dirty: false,
        };
        return [[slot]];
      }
      if (sql.includes('CREATE knowledge_artifact')) {
        slot = {
          payload: params.wrapped,
          sourceFactIds: (params.facts as Array<{ toString(): string }>).map(String),
          builtAt: new Date().toISOString(),
          staleAfterMs: 300_000,
          dirty: false,
        };
        return [[slot]];
      }
      return [[]];
    },
  };
  const surreal = {
    withScopedCompany: async (_c: string, _s: unknown, fn: (d: unknown) => Promise<unknown>) =>
      fn(db),
  } as unknown as SurrealService;
  // A tenant-authored predicate the static seed does not know.
  const registry = {
    rowPolicyLookup: async () => (p: string) =>
      p === 'salary_band'
        ? { requiresScope: 'brain:read_pii', piiClass: 'sensitive' }
        : p === 'dob'
          ? { requiresScope: 'brain:read_pii', piiClass: 'sensitive' }
          : { piiClass: 'none' },
  } as unknown as PredicateRegistryService;
  return { svc: new ArtifactsService(surreal, registry), sqls };
}

const PII: BrainScope[] = ['brain:read', 'brain:read_pii'];
const READ: BrainScope[] = ['brain:read'];

const get = (svc: ArtifactsService, artifactType: string, scopes: BrainScope[]) =>
  svc.getArtifact({ companyId: 'co_t', entityIdRaw: 'e1', artifactType, scopes });

describe('artifacts visibility', () => {
  it('an identity dossier built for read_pii is not served to a brain:read caller', async () => {
    const { svc } = harness();
    const full = await get(svc, 'identity_dossier', PII);
    expect(full.payload.dob).toEqual(['1990-01-01']);
    const narrow = await get(svc, 'identity_dossier', READ);
    expect(narrow.payload.dob).toBeUndefined();
    expect(narrow.payload.name).toEqual(['Ada']);
    expect(narrow.sourceFactIds).toEqual(['knowledge_fact:n']);
  });

  it('risk_snapshot lists only facts whose predicate the caller may read', async () => {
    const { svc } = harness();
    await get(svc, 'risk_snapshot', PII);
    const narrow = await get(svc, 'risk_snapshot', READ);
    const competing = narrow.payload.competingFacts as Array<{ predicate: string }>;
    expect(competing.map((f) => f.predicate)).toEqual(['name']);
    expect(narrow.payload.lowConfidenceFacts ?? []).toEqual([]);
    expect(narrow.sourceFactIds).not.toContain('knowledge_fact:d');
    expect(narrow.sourceFactIds).not.toContain('knowledge_fact:s');
  });

  it('the read_pii caller still gets the full view, and a same-visibility read hits the cache', async () => {
    const { svc, sqls } = harness();
    await get(svc, 'risk_snapshot', PII);
    const factReads = () => sqls.filter((q) => q.includes('FROM knowledge_fact')).length;
    expect(factReads()).toBe(1);
    const again = await get(svc, 'risk_snapshot', PII);
    expect(factReads()).toBe(1);
    const competing = again.payload.competingFacts as Array<{ predicate: string }>;
    expect(competing.map((f) => f.predicate).sort()).toEqual(['dob', 'name']);
  });

  it('defence in depth: a cached item list is re-filtered by item predicate on read', async () => {
    const { svc } = harness();
    await get(svc, 'risk_snapshot', PII);
    // Same caller visibility key is not available to READ, but shapeForReturn
    // must also scrub a record handed to it directly.
    const shaped = (svc as unknown as { shapeForReturn: (o: unknown) => any }).shapeForReturn({
      cached: {
        payload: { competingFacts: [{ predicate: 'dob' }, { predicate: 'name' }] },
        citations: {
          competingFacts: [{ factId: 'knowledge_fact:d' }, { factId: 'knowledge_fact:n' }],
        },
        sourceFactIds: ['knowledge_fact:d', 'knowledge_fact:n'],
        builtAt: new Date().toISOString(),
        staleAfterMs: 1000,
        dirty: false,
      },
      fullSelf: 'knowledge_entity:e1',
      scopes: READ,
      lookup: (p: string) =>
        p === 'dob' ? { requiresScope: 'brain:read_pii', piiClass: 'x' } : { piiClass: 'none' },
      ageMs: 0,
      artifactType: 'risk_snapshot',
    });
    expect(shaped.payload.competingFacts).toEqual([{ predicate: 'name' }]);
    expect(shaped.sourceFactIds).toEqual(['knowledge_fact:n']);
  });

  it('the fact query keeps the tenant-global fence', async () => {
    const { svc, sqls } = harness();
    await get(svc, 'identity_dossier', READ);
    expect(sqls.find((q) => q.includes('FROM knowledge_fact'))).toContain('userId IS NONE');
  });
});
