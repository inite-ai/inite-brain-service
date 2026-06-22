/**
 * Unit-test for ExtractorCacheService — key composition, hit/miss,
 * LRU eviction, NFC normalization, disabled fallback.
 */
import type { ConfigService } from '@nestjs/config';
import { ExtractorCacheService } from '../src/ai/extractor-cache.service';
import type { ExtractionResult } from '../src/ai/extractor.service';

function mkConfig(over: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    EXTRACTOR_CACHE_SIZE: '100',
    EXTRACTOR_CACHE_ENABLED: 'true',
    ...over,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

const stub: ExtractionResult = {
  entities: [{ name: 'Maria Petrov', type: 'staff' }],
  facts: [
    {
      entityIndex: 0,
      predicate: 'status',
      object: 'CTO',
      confidence: 0.9,
    },
  ],
  edges: [],
};

const baseInput = {
  text: 'Maria Petrov is our new CTO at Acme.',
  companyId: 'demo_live',
  predicateVocabHash: 'v-abc123',
};

describe('ExtractorCacheService.computeKey', () => {
  const svc = new ExtractorCacheService(mkConfig());

  it('same input → same key', () => {
    expect(svc.computeKey(baseInput)).toBe(svc.computeKey({ ...baseInput }));
  });

  it('text change → different key', () => {
    expect(svc.computeKey(baseInput)).not.toBe(
      svc.computeKey({ ...baseInput, text: 'Different message' }),
    );
  });

  it('tenant change → different key', () => {
    expect(svc.computeKey(baseInput)).not.toBe(
      svc.computeKey({ ...baseInput, companyId: 'other_tenant' }),
    );
  });

  it('registry version change → different key', () => {
    expect(svc.computeKey(baseInput)).not.toBe(
      svc.computeKey({ ...baseInput, predicateVocabHash: 'v-other' }),
    );
  });

  it('scPasses change → different key', () => {
    // A single-pass cached result lacks the semantic-entropy fields a
    // multi-pass run produces, so the key must split on scPasses.
    expect(svc.computeKey({ ...baseInput, scPasses: 1 })).not.toBe(
      svc.computeKey({ ...baseInput, scPasses: 3 }),
    );
  });

  it('omitted scPasses maps to the single-pass bucket', () => {
    expect(svc.computeKey(baseInput)).toBe(
      svc.computeKey({ ...baseInput, scPasses: 1 }),
    );
  });

  it('NFC-normalizes text', () => {
    // Composed: 'é' (U+00E9). Decomposed: 'e' + combining acute (U+0301).
    const composed = 'café';
    const decomposed = 'café';
    expect(composed).not.toBe(decomposed);
    expect(svc.computeKey({ ...baseInput, text: composed })).toBe(
      svc.computeKey({ ...baseInput, text: decomposed }),
    );
  });
});

describe('ExtractorCacheService get/set', () => {
  it('miss → undefined; hit → stored object', () => {
    const svc = new ExtractorCacheService(mkConfig());
    const key = svc.computeKey(baseInput);
    expect(svc.get(key)).toBeUndefined();
    svc.set(key, stub);
    expect(svc.get(key)).toBe(stub);
  });

  it('disabled cache always misses', () => {
    const svc = new ExtractorCacheService(
      mkConfig({ EXTRACTOR_CACHE_ENABLED: 'false' }),
    );
    svc.set('k', stub);
    expect(svc.get('k')).toBeUndefined();
    expect(svc.stats().enabled).toBe(false);
  });

  it('tracks hit/miss counts', () => {
    const svc = new ExtractorCacheService(mkConfig());
    const key = svc.computeKey(baseInput);
    svc.get(key); // miss
    svc.set(key, stub);
    svc.get(key); // hit
    svc.get(key); // hit
    const s = svc.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3, 5);
  });

  it('LRU evicts oldest past capacity', () => {
    const svc = new ExtractorCacheService(
      mkConfig({ EXTRACTOR_CACHE_SIZE: '2' }),
    );
    const k1 = svc.computeKey({ ...baseInput, text: 'a' });
    const k2 = svc.computeKey({ ...baseInput, text: 'b' });
    const k3 = svc.computeKey({ ...baseInput, text: 'c' });
    svc.set(k1, stub);
    svc.set(k2, stub);
    svc.set(k3, stub);
    expect(svc.get(k1)).toBeUndefined();
    expect(svc.get(k2)).toBe(stub);
    expect(svc.get(k3)).toBe(stub);
  });
});
