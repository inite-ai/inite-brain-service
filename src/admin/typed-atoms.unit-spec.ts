import {
  buildDeriverSystem,
  DERIVER_TYPED_SECTION,
  TYPED_ATOM_KINDS,
} from './deriver-client';

describe('DERIVER_TYPED_ATOMS (multiworld §10 — typed single-pass derive)', () => {
  it('system prompt gains the atom-types section only under the flag', () => {
    expect(buildDeriverSystem({ typedAtoms: true })).toContain('ATOM TYPES');
    expect(buildDeriverSystem({})).not.toContain('ATOM TYPES');
    expect(buildDeriverSystem()).toBe(
      buildDeriverSystem({ typedAtoms: false }),
    );
  });

  it('the prompt vocabulary and the row-builder gate are the same set', () => {
    // The response-schema enum, the prompt section and the stamp gate
    // must never drift apart: a kind the prompt teaches but the gate
    // drops silently un-types every row of that class.
    for (const kind of TYPED_ATOM_KINDS) {
      expect(DERIVER_TYPED_SECTION).toContain(`"${kind}"`);
    }
    expect(TYPED_ATOM_KINDS.size).toBe(4);
  });

  it('keeps the assistant-contribution payload rule (the SSA source fix)', () => {
    // assistant_contribution subsumes DERIVER_ASSISTANT_SECTION — the
    // concrete-payload rule is what makes the stored proposition able
    // to answer "what did you suggest…" on its own.
    expect(DERIVER_TYPED_SECTION).toMatch(/what did you suggest/);
    expect(DERIVER_TYPED_SECTION).toMatch(/CONTRIBUTING participant/);
  });

  it('defines a deterministic tie-break order for overlapping kinds', () => {
    expect(DERIVER_TYPED_SECTION).toMatch(
      /prefer assistant_contribution, then event, then persona_attr, then fact/,
    );
  });
});
