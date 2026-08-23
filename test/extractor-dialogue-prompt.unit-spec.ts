import {
  buildSystemPrompt,
  buildDialogueSystemPrompt,
  buildExtractionSchema,
  EXTRACTION_PROMPT_HEADER_DIALOGUE,
  OBJECT_NORMALIZATION_SECTION,
} from '../src/ai/extractor-internals/prompts';
import type { PredicateDefinition } from '../src/ai/predicate-registry.service';

/**
 * Phase 4 v2 dialogue extraction prompt. The load-bearing property: the OPEN
 * profile must NOT show the closed predicate vocabulary (that is the root cause
 * of catch-all anchoring / "conservative bias"), while the default closed
 * prompt still does. Guards against a regression that re-appends the cards.
 */
const SAMPLE_PREDICATES: PredicateDefinition[] = [
  {
    predicateId: 'interacted_with',
    semantics: 'append_only',
    description: 'CATCH-ALL one-off generic action (booked/viewed/attended/purchased).',
  } as PredicateDefinition,
  {
    predicateId: 'status',
    semantics: 'single_active',
    description: 'current role / lifecycle stage / membership.',
  } as PredicateDefinition,
];

describe('Phase 4 v2 dialogue extraction prompt', () => {
  it('closed (default) prompt DOES render the predicate cards', () => {
    const closed = buildSystemPrompt(SAMPLE_PREDICATES);
    expect(closed).toContain('interacted_with [append_only]');
    expect(closed).toContain('status [single_active]');
  });

  it('dialogue (open) prompt does NOT render any predicate card', () => {
    const open = buildDialogueSystemPrompt(SAMPLE_PREDICATES);
    // The card format is "\n<id> [<semantics>]\n<desc>" — none must appear.
    expect(open).not.toContain('interacted_with [append_only]');
    expect(open).not.toContain('status [single_active]');
    expect(open).not.toContain('CATCH-ALL');
    // It is exactly the open header (nothing appended).
    expect(open).toBe(EXTRACTION_PROMPT_HEADER_DIALOGUE);
  });

  it('dialogue prompt carries the evidence-based anti-catch-all rules', () => {
    const open = buildDialogueSystemPrompt([]);
    expect(open).toMatch(/COIN A SPECIFIC ONE/);
    expect(open).toMatch(/there is no fixed list/i);
    expect(open).toMatch(/PRESERVES SPECIFICITY/);
    expect(open).toMatch(/NEVER generalize/);
    expect(open).toMatch(/ENUMERATE/);
    expect(open).toMatch(/ATTRIBUTE TO THE ACTOR/);
    expect(open).toMatch(/when in doubt, EXTRACT/i);
    // and explicitly names the catch-alls it must avoid
    expect(open).toMatch(/interacted_with/);
    expect(open).toMatch(/preference/);
  });
});

describe('object normalization prompt/schema lockstep (E3b)', () => {
  it('flag off: schema and prompt are byte-identical to the base contract', () => {
    expect(JSON.stringify(buildExtractionSchema())).toBe(
      JSON.stringify(buildExtractionSchema({ objectNormalization: false })),
    );
    expect(buildSystemPrompt([])).not.toContain('NORMALIZED OBJECT');
    const factsSchema = (buildExtractionSchema() as any).properties.facts.items;
    expect(factsSchema.properties.object).toBeUndefined();
    expect(factsSchema.required).not.toContain('object');
  });

  it('flag on: prompt gains the section and the schema requires nullable object', () => {
    const prompt = buildSystemPrompt([], { objectNormalization: true });
    expect(prompt).toContain(OBJECT_NORMALIZATION_SECTION);
    const factsSchema = (buildExtractionSchema({ objectNormalization: true }) as any).properties
      .facts.items;
    expect(factsSchema.properties.object.type).toEqual(['string', 'null']);
    expect(factsSchema.required).toContain('object');
  });
});
