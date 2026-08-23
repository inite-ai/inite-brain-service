/**
 * Domain Pack extractionProfile CONSUMPTION — the second-pack track.
 *
 * A pack's extractionProfile (guidance + few-shot) is merged onto the tenant
 * snapshot (predicate-registry loadFresh) and injected into the extractor
 * system prompt. This spec covers the pure rendering + the ExtractorLlmService
 * assembly; the DB→snapshot→prompt round-trip is proven in the e2e.
 */
import { ExtractorLlmService } from '../src/ai/extractor-llm.service';
import { buildSystemPrompt, renderExtractionProfiles } from '../src/ai/extractor-internals/prompts';
import type { PackExtractionProfile } from '../src/ai/predicate-registry-internals/types';

const REAL_ESTATE_PROFILE: PackExtractionProfile = {
  packId: 'real_estate',
  profile: {
    guidance: 'Real-estate inputs describe properties. Prefer real_estate__* predicates.',
    fewShot: [
      {
        text: 'The parcel at 12 Elm St is zoned R-2.',
        note: "property '12 Elm St' → real_estate__zoned_as='R-2'.",
      },
    ],
  },
};

function stubConfig(): any {
  return {
    get: (k: string, def?: string) => {
      if (k === 'OPENAI_CHAT_MODEL') return 'gpt-test';
      if (k === 'OPENAI_CONCURRENCY') return '8';
      if (k === 'EXTRACTOR_SC_PASSES') return '1';
      return def;
    },
    getOrThrow: (k: string) => {
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      throw new Error(`getOrThrow missing: ${k}`);
    },
  };
}

describe('renderExtractionProfiles', () => {
  it('renders nothing for an empty profile list (byte-identical to pre-pack)', () => {
    expect(renderExtractionProfiles([])).toBe('');
  });

  it('renders nothing when profiles carry no guidance/fewShot', () => {
    expect(renderExtractionProfiles([{ packId: 'empty', profile: {} }])).toBe('');
  });

  it('renders the guidance, pack id, and few-shot example text', () => {
    const out = renderExtractionProfiles([REAL_ESTATE_PROFILE]);
    expect(out).toContain('DOMAIN EXTRACTION GUIDANCE');
    expect(out).toContain('[pack: real_estate]');
    expect(out).toContain('Prefer real_estate__* predicates');
    expect(out).toContain('EXAMPLES');
    expect(out).toContain('The parcel at 12 Elm St is zoned R-2.');
    expect(out).toContain("real_estate__zoned_as='R-2'");
  });

  it('skips profiles with no content but keeps those with content', () => {
    const out = renderExtractionProfiles([{ packId: 'empty', profile: {} }, REAL_ESTATE_PROFILE]);
    expect(out).toContain('[pack: real_estate]');
    expect(out).not.toContain('[pack: empty]');
  });
});

describe('ExtractorLlmService.composeSystemPrompt — profile injection', () => {
  it('appends the profile block after the predicate vocabulary', () => {
    const llm = new ExtractorLlmService(stubConfig());
    const withProfile = llm.composeSystemPrompt({
      active: [],
      extractionProfiles: [REAL_ESTATE_PROFILE],
    });
    const withoutProfile = llm.composeSystemPrompt({ active: [] });

    // The base (header + cards) is unchanged; the profile is purely additive.
    expect(withProfile.startsWith(withoutProfile)).toBe(true);
    expect(withProfile.length).toBeGreaterThan(withoutProfile.length);
    expect(withProfile).toContain('Prefer real_estate__* predicates');
    // The static header/schema contract is still present.
    expect(withProfile).toContain('THE VERBATIM RULE');
  });

  it('is byte-identical to the base prompt when no profiles are present', () => {
    const llm = new ExtractorLlmService(stubConfig());
    expect(llm.composeSystemPrompt({ active: [] })).toBe(buildSystemPrompt([]));
  });
});
