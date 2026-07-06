/**
 * Code-memory Phase 2b — anchor re-validation service, end-to-end on a real DB.
 *
 * Proves list → invalidate → reanchor against the actual store:
 *   - listAnchors surfaces anchors carrying active code-memory facts;
 *   - invalidateAnchor retracts an anchor's facts (dropped from `why`, kept for
 *     audit);
 *   - reanchor makes the preserved facts resolve under a new (renamed) symbol.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { IngestService } from '../src/ingest/ingest.service';
import { EntitiesService } from '../src/entities/entities.service';
import { CodeMemoryAnchorService } from '../src/code-memory/code-memory-anchor.service';
import { codeMemoryPredicateId } from '../src/ai/domain-packs';

describe('code-memory Phase 2b — anchor re-validation service', () => {
  let f: AppFixture;
  const SCOPES = ['brain:read', 'brain:read_pii', 'brain:admin'] as any;
  const ANCHOR_A = 'src/x.ts#Foo.bar';
  const ANCHOR_B = 'src/y.ts#Baz.qux';
  const ANCHOR_B_NEW = 'src/y.ts#Baz.renamed';

  const activeCodeFacts = async (anchor: string) => {
    const entities = f.app.get(EntitiesService);
    const profile = await entities.getProfileByExternalRef({
      companyId: f.companyId,
      vertical: 'code',
      id: anchor,
      asOfRaw: undefined,
      scopes: SCOPES,
    });
    return (profile?.facts ?? []).filter((x) =>
      x.predicate.startsWith('code_memory__'),
    );
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_code_anchor_e2e' });
    const ingest = f.app.get(IngestService);
    await ingest.ingestFact(f.companyId, {
      entityRef: { vertical: 'code', id: ANCHOR_A },
      predicate: codeMemoryPredicateId('decided'),
      object: 'Foo.bar owns the decision',
      validFrom: '2026-07-07T00:00:00Z',
      source: { vertical: 'code', recorder: 'code_memory' },
    });
    await ingest.ingestFact(f.companyId, {
      entityRef: { vertical: 'code', id: ANCHOR_B },
      predicate: codeMemoryPredicateId('gotcha'),
      object: 'Baz.qux has a subtle trap',
      validFrom: '2026-07-07T00:00:00Z',
      source: { vertical: 'code', recorder: 'code_memory' },
    });
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('listAnchors surfaces anchors with active code-memory facts', async () => {
    const svc = f.app.get(CodeMemoryAnchorService);
    const anchors = await svc.listAnchors(f.companyId, SCOPES);
    const map = new Map(anchors.map((a) => [a.anchor, a]));
    expect(map.has(ANCHOR_A)).toBe(true);
    expect(map.has(ANCHOR_B)).toBe(true);
    expect(map.get(ANCHOR_A)!.factIds.length).toBeGreaterThanOrEqual(1);
  });

  it('invalidateAnchor retracts an anchor and drops it from why', async () => {
    const svc = f.app.get(CodeMemoryAnchorService);
    expect((await activeCodeFacts(ANCHOR_A)).length).toBe(1);

    const n = await svc.invalidateAnchor(f.companyId, ANCHOR_A, 'symbol removed');
    expect(n).toBe(1);
    expect((await activeCodeFacts(ANCHOR_A)).length).toBe(0);
  });

  it('reanchor makes preserved facts resolve under the renamed symbol', async () => {
    const svc = f.app.get(CodeMemoryAnchorService);
    const r = await svc.reanchor(f.companyId, ANCHOR_B, ANCHOR_B_NEW);
    expect(r.reanchored).toBe(true);

    const viaNew = await activeCodeFacts(ANCHOR_B_NEW);
    expect(viaNew.length).toBe(1);
    expect(viaNew[0].object).toMatch(/subtle trap/);
  });
});
