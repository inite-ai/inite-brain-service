/**
 * Persona Domain Pack — personal user memory (Synthius-Mem-inspired).
 * First first-party pack to carry a `sensitive` + requiresScope predicate
 * and an enum predicate. Guards: manifest validity, JSON lockstep,
 * extractionProfile shape, and the routing decisions that keep the pack
 * from colliding with core `preference` / `intent`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_PACKS,
  packChecksum,
  PERSONA_PACK,
  validatePack,
  type DomainPackManifest,
} from '../src/ai/domain-packs';

describe('persona pack', () => {
  it('is a valid pack', () => {
    expect(() => validatePack(PERSONA_PACK)).not.toThrow();
  });

  it('declares the expected localIds', () => {
    const localIds = PERSONA_PACK.predicates.map((p) => p.localId).sort();
    expect(localIds).toEqual([
      'closeness',
      'dislike',
      'education',
      'employer',
      'felt',
      'health_condition',
      'life_event',
      'occupation',
      'relationship_role',
      'skill',
    ]);
  });

  it('does NOT shadow core preference / intent (routing collision guard)', () => {
    const localIds = PERSONA_PACK.predicates.map((p) => p.localId);
    expect(localIds).not.toContain('preference');
    expect(localIds).not.toContain('intent');
    // Positive likes route to core preference — the extractionProfile must say so.
    expect(PERSONA_PACK.extractionProfile?.guidance).toMatch(/core preference/i);
  });

  it('gates health_condition as sensitive + requiresScope', () => {
    const health = PERSONA_PACK.predicates.find(
      (p) => p.localId === 'health_condition',
    );
    expect(health?.piiClass).toBe('sensitive');
    expect(health?.requiresScope).toBe('brain:read_pii');
  });

  it('closeness is an enum with the three closeness levels', () => {
    const closeness = PERSONA_PACK.predicates.find(
      (p) => p.localId === 'closeness',
    );
    expect(closeness?.datatype).toBe('enum');
    expect(closeness?.allowedValues).toEqual(['close', 'moderate', 'distant']);
  });

  it('models work history with bitemporal occupation/employer', () => {
    const occ = PERSONA_PACK.predicates.find((p) => p.localId === 'occupation');
    const emp = PERSONA_PACK.predicates.find((p) => p.localId === 'employer');
    expect(occ?.semantics).toBe('bitemporal');
    expect(emp?.semantics).toBe('bitemporal');
  });

  it('ships an extractionProfile + eval fixtures', () => {
    expect(PERSONA_PACK.extractionProfile?.guidance?.length ?? 0).toBeGreaterThan(0);
    expect(PERSONA_PACK.extractionProfile?.fewShot?.length ?? 0).toBeGreaterThan(0);
    expect(PERSONA_PACK.evalFixtures?.length ?? 0).toBeGreaterThan(0);
    for (const f of PERSONA_PACK.evalFixtures ?? []) {
      expect((f.expect.facts ?? []).length).toBeGreaterThan(0);
    }
  });

  it('is DISTRIBUTABLE — not a builtin', () => {
    expect(BUILTIN_PACKS.some((p) => p.id === 'persona')).toBe(false);
  });

  it('the committed JSON artifact matches the TS source of truth', () => {
    const jsonPath = join(__dirname, '..', 'packs', 'persona.pack.json');
    const fromJson = JSON.parse(
      readFileSync(jsonPath, 'utf8'),
    ) as DomainPackManifest;
    expect(fromJson).toEqual(PERSONA_PACK);
    expect(packChecksum(fromJson)).toBe(packChecksum(PERSONA_PACK));
  });
});
