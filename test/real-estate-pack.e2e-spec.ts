/**
 * Real-estate pack extractionProfile — end-to-end on a real DB.
 *
 * Proves the DomainPack machine consumes a pack's extractionProfile all the way
 * through: install the distributable real_estate manifest at runtime → its
 * profile lands on the tenant's predicate snapshot (via domain_pack read in
 * loadFresh) → the extractor system prompt carries the domain guidance +
 * few-shot. Uninstall removes it again. No OpenAI call — we assert on the
 * assembled prompt, not a completion.
 */
import { ExtractorLlmService } from '../src/ai/extractor-llm.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { REAL_ESTATE_PACK } from '../src/ai/domain-packs';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('real_estate pack — extractionProfile consumption (e2e)', () => {
  let f: AppFixture;
  let registry: PredicateRegistryService;
  let llm: ExtractorLlmService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_real_estate_profile_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
    });
    registry = f.app.get(PredicateRegistryService, { strict: false });
    llm = f.app.get(ExtractorLlmService, { strict: false });
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('carries only builtin profiles before the pack is installed', async () => {
    const snap = await registry.getSnapshot(f.companyId);
    expect(snap.extractionProfiles.some((p) => p.packId === 'real_estate')).toBe(
      false,
    );
    // The base extractor prompt does NOT mention the real-estate domain yet.
    expect(llm.composeSystemPrompt(snap)).not.toContain(
      'real_estate__zoned_as',
    );
  });

  it('installs the real_estate pack and surfaces its profile on the snapshot', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: REAL_ESTATE_PACK });
    expect([200, 201]).toContain(r.status);
    expect(r.body.packId).toBe('real_estate');
    expect(r.body.predicatesSeeded).toBe(REAL_ESTATE_PACK.predicates.length);

    const snap = await registry.getSnapshot(f.companyId);
    const profile = snap.extractionProfiles.find(
      (p) => p.packId === 'real_estate',
    );
    expect(profile).toBeDefined();
    expect(profile!.profile.guidance).toContain('real_estate__zoned_as');
    expect(profile!.profile.fewShot!.length).toBeGreaterThan(0);
  });

  it('injects the profile into the assembled extractor system prompt', async () => {
    const snap = await registry.getSnapshot(f.companyId);
    const prompt = llm.composeSystemPrompt(snap);
    expect(prompt).toContain('DOMAIN EXTRACTION GUIDANCE');
    expect(prompt).toContain('[pack: real_estate]');
    expect(prompt).toContain('real_estate__zoned_as');
    // The seeded predicate cards are present too (predicates went active).
    expect(prompt).toContain('real_estate__encumbered_by');
    // Static contract intact.
    expect(prompt).toContain('THE VERBATIM RULE');
  });

  it('uninstalling the pack removes its profile from the snapshot', async () => {
    const del = await f.http
      .delete('/v1/admin/packs/real_estate')
      .set(auth());
    expect(del.status).toBe(200);

    const snap = await registry.getSnapshot(f.companyId);
    expect(snap.extractionProfiles.some((p) => p.packId === 'real_estate')).toBe(
      false,
    );
    // Deprecated predicates drop out of the active vocabulary too.
    expect(llm.composeSystemPrompt(snap)).not.toContain('[pack: real_estate]');
  });
});
