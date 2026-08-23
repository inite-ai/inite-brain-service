/**
 * pack:init scaffold (scripts/init-pack.ts) — the community-author on-ramp.
 * The generated skeleton must ALWAYS be a valid, core-collision-free manifest
 * (a fresh `pnpm pack:init` output passes `pnpm pack:validate` unedited), and
 * the id gate must refuse malformed + reserved builtin/first-party ids.
 */
import { makePackSkeleton, RESERVED_PACK_IDS } from '../scripts/init-pack';
import { assembleSeed, validatePack, DomainPackError } from '../src/ai/domain-packs';
import { CORE_PREDICATES } from '../src/ai/predicate-registry-internals/core-seed';

describe('pack:init skeleton', () => {
  it('passes validatePack unedited', () => {
    const skeleton = makePackSkeleton('my_test_pack');
    expect(() => validatePack(skeleton)).not.toThrow();
    expect(skeleton.id).toBe('my_test_pack');
    expect(skeleton.version).toBe('0.1.0');
  });

  it('assembles onto the core seed collision-free (namespaced)', () => {
    const skeleton = makePackSkeleton('my_test_pack');
    expect(() => assembleSeed(CORE_PREDICATES, [skeleton])).not.toThrow();
    const merged = assembleSeed(CORE_PREDICATES, [skeleton]);
    expect(merged.some((p) => p.predicateId === 'my_test_pack__example_predicate')).toBe(true);
    // Pack predicates are stamped createdBy:'system' by the assembler.
    const composed = merged.find((p) => p.predicateId === 'my_test_pack__example_predicate');
    expect(composed?.createdBy).toBe('system');
  });

  it('ships an extractionProfile stub and one eval fixture', () => {
    const skeleton = makePackSkeleton('my_test_pack');
    expect(skeleton.extractionProfile?.guidance?.length ?? 0).toBeGreaterThan(0);
    expect(skeleton.extractionProfile?.fewShot?.length ?? 0).toBeGreaterThan(0);
    expect(skeleton.evalFixtures?.length ?? 0).toBeGreaterThan(0);
    for (const f of skeleton.evalFixtures ?? []) {
      expect(typeof f.id).toBe('string');
      expect(typeof f.text).toBe('string');
      expect((f.expect.facts ?? []).length).toBeGreaterThan(0);
    }
  });

  it('marks the indexer descriptor example as clearly optional (non-standard key)', () => {
    const skeleton = makePackSkeleton('my_test_pack');
    // The example rides a non-standard "// indexer" key so the skeleton stays
    // a plain valid manifest; a real opt-in uses a top-level `indexer` field.
    expect(skeleton['// indexer']).toBeDefined();
    expect((skeleton as { indexer?: unknown }).indexer).toBeUndefined();
    const modes = skeleton['// indexer'] as Record<string, { mode?: string } | string>;
    expect((modes.virtual as { mode?: string }).mode).toBe('virtual');
    expect((modes.dedicated as { mode?: string }).mode).toBe('dedicated');
    expect((modes.external as { mode?: string }).mode).toBe('external');
  });

  it('rejects malformed ids (charset / "__" separator / trailing underscore)', () => {
    for (const bad of ['My-Pack', '1pack', 'foo__bar', 'foo_', '']) {
      expect(() => makePackSkeleton(bad)).toThrow(DomainPackError);
    }
  });

  it('refuses reserved builtin/first-party pack ids', () => {
    const reserved = [
      'code_memory',
      'real_estate',
      'fintech',
      'medical',
      'legal',
      'insurance',
      'hr',
    ];
    for (const id of reserved) {
      expect(RESERVED_PACK_IDS.has(id)).toBe(true);
      expect(() => makePackSkeleton(id)).toThrow(/reserved/);
    }
  });
});
