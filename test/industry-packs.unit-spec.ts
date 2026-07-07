/**
 * Industry Domain Pack library — fintech / medical / legal (+ real_estate).
 * Each is a complete, self-verifying, DISTRIBUTABLE pack: valid manifest, an
 * extractionProfile, eval fixtures, a committed JSON artifact kept in sync with
 * the TS source, and deliberately NOT a builtin. Together they seed the registry
 * collision-free.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleSeed,
  BUILTIN_PACKS,
  FIRST_PARTY_PACKS,
  packChecksum,
  validatePack,
  type DomainPackManifest,
} from '../src/ai/domain-packs';
import { CORE_PREDICATES } from '../src/ai/predicate-registry-internals/core-seed';

// Every first-party pack except real_estate (which has its own spec).
const INDUSTRY: DomainPackManifest[] = FIRST_PARTY_PACKS.filter(
  (p) => p.id !== 'real_estate',
);

describe.each(INDUSTRY.map((p) => [p.id, p] as const))(
  'industry pack: %s',
  (id, pack) => {
    it('is a valid pack with >= 4 namespaced predicates', () => {
      expect(() => validatePack(pack)).not.toThrow();
      expect(pack.predicates.length).toBeGreaterThanOrEqual(4);
      expect(pack.id).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('ships an extractionProfile (guidance + few-shot)', () => {
      expect(pack.extractionProfile?.guidance?.length ?? 0).toBeGreaterThan(0);
      expect(pack.extractionProfile?.fewShot?.length ?? 0).toBeGreaterThan(0);
    });

    it('ships eval fixtures with fact expectations', () => {
      expect(pack.evalFixtures?.length ?? 0).toBeGreaterThan(0);
      for (const f of pack.evalFixtures ?? []) {
        expect(typeof f.id).toBe('string');
        expect(typeof f.text).toBe('string');
        expect((f.expect.facts ?? []).length).toBeGreaterThan(0);
      }
    });

    it('is DISTRIBUTABLE — not a builtin', () => {
      expect(BUILTIN_PACKS.some((p) => p.id === id)).toBe(false);
    });

    it('has a committed JSON artifact matching the TS source', () => {
      const file = join(
        __dirname,
        '..',
        'packs',
        `${id.replace(/_/g, '-')}.pack.json`,
      );
      const fromJson = JSON.parse(readFileSync(file, 'utf8')) as DomainPackManifest;
      expect(fromJson).toEqual(pack);
      expect(packChecksum(fromJson)).toBe(packChecksum(pack));
    });
  },
);

describe('first-party pack library', () => {
  it('lists the industry packs + real_estate', () => {
    const ids = FIRST_PARTY_PACKS.map((p) => p.id).sort();
    expect(ids).toEqual([
      'fintech',
      'hr',
      'insurance',
      'legal',
      'medical',
      'real_estate',
    ]);
  });

  it('seeds together with core collision-free (namespaced)', () => {
    expect(() => assembleSeed(CORE_PREDICATES, FIRST_PARTY_PACKS)).not.toThrow();
    const merged = assembleSeed(CORE_PREDICATES, FIRST_PARTY_PACKS);
    expect(merged.some((p) => p.predicateId === 'fintech__regulated_by')).toBe(true);
    expect(merged.some((p) => p.predicateId === 'medical__treats')).toBe(true);
    expect(merged.some((p) => p.predicateId === 'legal__governed_by')).toBe(true);
  });
});
