import { denoiseFacts } from '../src/ai/extractor-internals/denoise';
import { resolveExtractionProfile } from '../src/ai/extraction-profile';

const dropSaid = () => resolveExtractionProfile().dropSaid;
import type { ExtractedFact } from '../src/ai/extractor-internals/types';

/**
 * EXTRACTOR_DROP_SAID — drop the generic `said` small-talk the closed-vocab
 * LLM over-emits. Off (default) → identity so extraction is byte-identical.
 */
describe('denoiseFacts (EXTRACTOR_DROP_SAID)', () => {
  const facts: ExtractedFact[] = [
    { entityIndex: 0, predicate: 'said', object: 'Congrats Caroline!', confidence: 0.9 },
    { entityIndex: 0, predicate: 'preference', object: 'pottery', confidence: 0.9 },
    { entityIndex: 0, predicate: 'said', object: 'What motivates you?', confidence: 0.8 },
    { entityIndex: 1, predicate: 'interacted_with', object: 'camping', confidence: 0.7 },
  ];

  afterEach(() => {
    delete process.env.EXTRACTOR_DROP_SAID;
  });

  it('off → identity (same array reference, byte-identical)', () => {
    const out = denoiseFacts(facts, dropSaid());
    expect(out).toBe(facts);
  });

  it('on → drops every `said` fact, keeps the rest in order', () => {
    process.env.EXTRACTOR_DROP_SAID = '1';
    const out = denoiseFacts(facts, dropSaid());
    expect(out.map((f) => f.predicate)).toEqual(['preference', 'interacted_with']);
    expect(out.map((f) => f.object)).toEqual(['pottery', 'camping']);
  });

  it('on → does not mutate the input array', () => {
    process.env.EXTRACTOR_DROP_SAID = '1';
    denoiseFacts(facts, dropSaid());
    expect(facts).toHaveLength(4); // original untouched
  });

  it('on → all-said input yields empty', () => {
    process.env.EXTRACTOR_DROP_SAID = '1';
    const allSaid: ExtractedFact[] = [
      { entityIndex: 0, predicate: 'said', object: 'hi', confidence: 1 },
    ];
    expect(denoiseFacts(allSaid, dropSaid())).toEqual([]);
  });
});
