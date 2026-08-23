/**
 * Code-memory Phase 3 — eval gate on a real DB.
 *
 * Ingests the frozen golden fixture into an ephemeral tenant and scores the two
 * guarantees the domain must hold:
 *   1. exact `why(anchor)` recall = 1.0 — the stored "why" always comes back at
 *      the anchor an agent is touching.
 *   2. invariant surfacing = 1.0 — every recorded invariant is handed back at
 *      its anchor (the design-constraint-compliance precondition).
 *
 * NL/semantic recall over code-memory (finding a decision by topic through the
 * general entity-centric search) is deliberately NOT gated here: code anchors
 * have path-string names, not NL names, so the general retriever doesn't surface
 * them by topic out of the box. That's a real follow-up (Phase 3b — a
 * code-memory-aware retrieval leg), not a domain guarantee, so it stays out of
 * the gate rather than being faked. GOLDEN_QUERIES.semanticQuery is retained for
 * that future eval.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { IngestService } from '../src/ingest/ingest.service';
import { EntitiesService } from '../src/entities/entities.service';
import { CodeMemorySearchService } from '../src/code-memory/code-memory-search.service';
import { codeMemoryKindOf, codeMemoryPredicateId } from '../src/ai/domain-packs';
import { GOLDEN_QUERIES, GOLDEN_RECORDS } from '../src/code-memory/eval/golden';
import { mean, recall } from '../src/code-memory/eval/metrics';

describe('code-memory Phase 3 — eval (recall + invariant surfacing)', () => {
  let f: AppFixture;
  const READ = ['brain:read', 'brain:read_pii'] as any;

  const recallProfile = (anchor: string) => {
    const entities = f.app.get(EntitiesService);
    return entities.getProfileByExternalRef({
      companyId: f.companyId,
      vertical: 'code',
      id: anchor,
      asOfRaw: undefined,
      scopes: READ,
    });
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_code_memory_eval' });
    const ingest = f.app.get(IngestService);
    for (const r of GOLDEN_RECORDS) {
      await ingest.ingestFact(f.companyId, {
        entityRef: { vertical: 'code', id: r.anchor },
        predicate: codeMemoryPredicateId(r.kind),
        object: r.text,
        validFrom: '2026-07-07T00:00:00Z',
        source: { vertical: 'code', recorder: 'code_memory' },
      });
    }
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('exact why() recall = 1.0 across golden queries', async () => {
    const recalls: number[] = [];
    for (const q of GOLDEN_QUERIES) {
      const profile = await recallProfile(q.anchor);
      const kinds = (profile?.facts ?? [])
        .filter((x) => x.status === 'active')
        .map((x) => codeMemoryKindOf(x.predicate));
      recalls.push(recall(q.expectKinds, kinds));
    }
    expect(mean(recalls)).toBe(1);
  });

  it('every recorded invariant is surfaced at its anchor', async () => {
    const invariants = GOLDEN_RECORDS.filter((r) => r.kind === 'invariant');
    let surfaced = 0;
    for (const inv of invariants) {
      const profile = await recallProfile(inv.anchor);
      const texts = (profile?.facts ?? [])
        .filter((x) => x.status === 'active')
        .map((x) => x.object);
      if (texts.includes(inv.text)) surfaced += 1;
    }
    expect(surfaced).toBe(invariants.length);
  });

  it('recall_decisions surfaces code-memory by NL topic (0 via the general search)', async () => {
    const cm = f.app.get(CodeMemorySearchService);
    const recalls: number[] = [];
    for (const q of GOLDEN_QUERIES) {
      const decisions = await cm.recall({
        companyId: f.companyId,
        query: q.semanticQuery,
        limit: 20,
        scopes: READ,
      });
      const anchors = new Set(decisions.map((d) => d.anchor));
      recalls.push(anchors.has(q.anchor) ? 1 : 0);
    }
    // Dedicated code-memory retrieval leg: every query's anchor is recalled,
    // where the general entity-centric search returned nothing.
    expect(mean(recalls)).toBe(1);
  });
});
