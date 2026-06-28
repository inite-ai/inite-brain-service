/**
 * Code-memory Phase 0 — end-to-end round-trip on a real DB.
 *
 * Proves the code-memory DomainPack lands on brain's existing primitives with
 * no new storage: a decision is recorded against a CODE ANCHOR (a
 * knowledge_entity addressed by a SCIP-style symbol string, not line numbers)
 * as a typed fact, recalled by external ref, and the bitemporal conflict path
 * gives decision evolution for free.
 *
 * What the MCP tools `record_decision` / `why` wrap is exercised directly:
 *   - record_decision  → IngestService.ingestFact (code predicate + anchor ref)
 *   - why              → EntitiesService.getProfileByExternalRef
 *
 * Asserts:
 *   1. record `decided` on a fresh anchor → INSERTED; recall returns it.
 *   2. re-`decided` the same anchor → SUPERSEDED; exactly one active decision,
 *      the new one (single_active evolution).
 *   3. `gotcha` is append_only → accumulates, no supersede.
 *   4. unknown anchor → null.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { IngestService } from '../src/ingest/ingest.service';
import { EntitiesService } from '../src/entities/entities.service';
import type { BrainScope } from '../src/auth/api-key.types';
import {
  codeMemoryPredicateId,
  type CodeMemoryKind,
} from '../src/ai/domain-packs';

describe('code-memory Phase 0 — record_decision → why round-trip', () => {
  let f: AppFixture;
  const READ: BrainScope[] = ['brain:read'];
  // SCIP-style anchor: dots in the path are escaped to "__" by externalRefKey
  // on both the write (ingest) and read (getProfileByExternalRef) sides.
  const SYMBOL =
    'inite-brain-service/src/ingest/fact-resolver.service.ts/FactResolverService#resolve';

  const recall = () => {
    const entities = f.app.get(EntitiesService);
    return entities.getProfileByExternalRef({
      companyId: f.companyId,
      vertical: 'code',
      id: SYMBOL,
      asOfRaw: undefined,
      scopes: READ,
    });
  };
  const activeOf = (
    profile: Awaited<ReturnType<typeof recall>>,
    kind: CodeMemoryKind,
  ) =>
    (profile?.facts ?? []).filter(
      (x) => x.predicate === codeMemoryPredicateId(kind) && x.status === 'active',
    );

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_code_memory_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('records a decision on a code anchor and recalls it by external ref', async () => {
    const ingest = f.app.get(IngestService);
    const out = await ingest.ingestFact(f.companyId, {
      entityRef: { vertical: 'code', id: SYMBOL },
      predicate: codeMemoryPredicateId('decided'),
      object: 'Route every fact write through one fn::resolve_fact gateway',
      validFrom: '2026-06-28T00:00:00Z',
      source: { vertical: 'code', recorder: 'code_memory', eventId: 'f0e824b' },
    });
    expect(out.outcome).toBe('INSERTED');

    const profile = await recall();
    expect(profile).not.toBeNull();
    const decided = activeOf(profile, 'decided');
    expect(decided).toHaveLength(1);
    expect(decided[0].object).toMatch(/one fn::resolve_fact gateway/);
  });

  it('re-deciding the same anchor supersedes the prior decision (single_active)', async () => {
    const ingest = f.app.get(IngestService);
    const out = await ingest.ingestFact(f.companyId, {
      entityRef: { vertical: 'code', id: SYMBOL },
      predicate: codeMemoryPredicateId('decided'),
      object: 'Gateway also detects locale and writes the HyPE alt-embedding',
      validFrom: '2026-06-29T00:00:00Z',
      source: { vertical: 'code', recorder: 'code_memory', eventId: 'a002e1f' },
    });
    expect(out.outcome).toBe('SUPERSEDED');

    const profile = await recall();
    const activeDecided = activeOf(profile, 'decided');
    expect(activeDecided).toHaveLength(1);
    expect(activeDecided[0].object).toMatch(/HyPE alt-embedding/);
  });

  it('gotcha is append_only — accumulates instead of superseding', async () => {
    const ingest = f.app.get(IngestService);
    await ingest.ingestFact(f.companyId, {
      entityRef: { vertical: 'code', id: SYMBOL },
      predicate: codeMemoryPredicateId('gotcha'),
      object: 'conflict weights are read from process.env, not ConfigService',
      validFrom: '2026-06-28T00:00:00Z',
      source: { vertical: 'code', recorder: 'code_memory' },
    });
    await ingest.ingestFact(f.companyId, {
      entityRef: { vertical: 'code', id: SYMBOL },
      predicate: codeMemoryPredicateId('gotcha'),
      object: 'the resolve lock key is companyId + entityId + predicate (NUL-joined)',
      validFrom: '2026-06-28T00:00:00Z',
      source: { vertical: 'code', recorder: 'code_memory' },
    });

    const profile = await recall();
    expect(activeOf(profile, 'gotcha')).toHaveLength(2);
    // The superseded decision from the prior test is still on the anchor but
    // not active — recall surfaces the full picture, active-filtered by kind.
    expect(activeOf(profile, 'decided')).toHaveLength(1);
  });

  it('returns null for an unknown anchor', async () => {
    const entities = f.app.get(EntitiesService);
    const profile = await entities.getProfileByExternalRef({
      companyId: f.companyId,
      vertical: 'code',
      id: 'inite-brain-service/src/does/not/exist.ts/Nope#missing',
      asOfRaw: undefined,
      scopes: READ,
    });
    expect(profile).toBeNull();
  });
});
