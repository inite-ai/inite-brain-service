/**
 * Real-estate Domain Pack — the second real pack, and the first to ship an
 * extractionProfile. Guards: manifest validity, the committed JSON artifact
 * (packs/real-estate.pack.json) stays in sync with the TS source of truth, the
 * extractionProfile shape, and that it is DISTRIBUTABLE (not a builtin).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_PACKS,
  packChecksum,
  REAL_ESTATE_PACK,
  validatePack,
  type DomainPackManifest,
} from '../src/ai/domain-packs';

describe('real-estate pack', () => {
  it('is a valid pack', () => {
    expect(() => validatePack(REAL_ESTATE_PACK)).not.toThrow();
  });

  it('namespaces every predicate under real_estate__*', () => {
    // The pack declares localIds; the loader composes real_estate__<localId>.
    const localIds = REAL_ESTATE_PACK.predicates.map((p) => p.localId);
    expect(localIds).toEqual(
      expect.arrayContaining([
        'zoned_as',
        'valued_at',
        'listed_at',
        'encumbered_by',
        'tenure_type',
        'built_in',
      ]),
    );
  });

  it('ships an extractionProfile with guidance + few-shot', () => {
    const p = REAL_ESTATE_PACK.extractionProfile;
    expect(p).toBeDefined();
    expect(typeof p!.guidance).toBe('string');
    expect(p!.guidance!.length).toBeGreaterThan(0);
    expect(Array.isArray(p!.fewShot)).toBe(true);
    expect(p!.fewShot!.length).toBeGreaterThan(0);
    for (const ex of p!.fewShot!) {
      expect(typeof ex.text).toBe('string');
      expect(typeof ex.note).toBe('string');
    }
  });

  it('ships eval fixtures with pack-local predicate expectations', () => {
    const fx = REAL_ESTATE_PACK.evalFixtures;
    expect(fx).toBeDefined();
    expect(fx!.length).toBeGreaterThan(0);
    for (const f of fx!) {
      expect(typeof f.id).toBe('string');
      expect(typeof f.text).toBe('string');
    }
    expect(fx!.some((f) => f.id === 'zoning')).toBe(true);
  });

  it('is DISTRIBUTABLE — deliberately NOT a builtin pack', () => {
    // Builtins seed into every tenant; real-estate must be installed per-tenant
    // so its domain predicates don't pollute unrelated tenants' extraction.
    expect(BUILTIN_PACKS.some((p) => p.id === 'real_estate')).toBe(false);
  });

  it('the committed JSON artifact matches the TS source of truth', () => {
    // Drift guard: `packs/real-estate.pack.json` is the installable artifact
    // (`pnpm pack:install --file ...`); it is generated from REAL_ESTATE_PACK.
    // If this fails, regenerate the JSON from the TS constant.
    const jsonPath = join(__dirname, '..', 'packs', 'real-estate.pack.json');
    const fromJson = JSON.parse(
      readFileSync(jsonPath, 'utf8'),
    ) as DomainPackManifest;
    expect(fromJson).toEqual(REAL_ESTATE_PACK);
    // Same content ⇒ same checksum ⇒ install --verify round-trips.
    expect(packChecksum(fromJson)).toBe(packChecksum(REAL_ESTATE_PACK));
  });
});
