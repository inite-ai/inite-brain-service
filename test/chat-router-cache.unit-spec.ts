/**
 * Unit-test for ChatRouterCacheService — key composition and hit/miss
 * isolation across tenant, knownNames, predicate vocab, and temporal
 * day-bucket dimensions.
 */
import { ConfigService } from '@nestjs/config';
import { ChatRouterCacheService } from '../src/admin/chat-router-cache.service';
import type { ChatRoute } from '../src/admin/chat-router.service';

function mkConfig(overrides: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    CHAT_ROUTE_CACHE_SIZE: '100',
    CHAT_ROUTE_CACHE_ENABLED: 'true',
    ...overrides,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

const stubRoute: ChatRoute = {
  intent: 'ask',
  normalizedMessage: 'where Maria Petrov lives',
  mentions: [],
  predicateHints: [],
};

const baseInput = {
  companyId: 'demo_live',
  message: 'where does Maria live?',
  knownNames: ['Maria Petrov'],
  predicateVocab: ['address', 'preference'],
  hasTemporal: false,
  now: new Date('2026-06-14T10:00:00Z'),
};

describe('ChatRouterCacheService.computeKey', () => {
  const svc = new ChatRouterCacheService(mkConfig());

  it('produces the same key for identical input', () => {
    expect(svc.computeKey(baseInput)).toBe(svc.computeKey({ ...baseInput }));
  });

  it('changes key when message differs', () => {
    expect(svc.computeKey(baseInput)).not.toBe(
      svc.computeKey({ ...baseInput, message: 'where does Petya live?' }),
    );
  });

  it('changes key when companyId differs', () => {
    expect(svc.computeKey(baseInput)).not.toBe(
      svc.computeKey({ ...baseInput, companyId: 'other_tenant' }),
    );
  });

  it('changes key when knownNames set differs', () => {
    expect(svc.computeKey(baseInput)).not.toBe(
      svc.computeKey({ ...baseInput, knownNames: ['Maria Petrov', 'John'] }),
    );
  });

  it('is order-independent within knownNames (stable hash)', () => {
    expect(
      svc.computeKey({ ...baseInput, knownNames: ['A', 'B', 'C'] }),
    ).toBe(svc.computeKey({ ...baseInput, knownNames: ['C', 'A', 'B'] }));
  });

  it('changes key when predicateVocab differs', () => {
    expect(svc.computeKey(baseInput)).not.toBe(
      svc.computeKey({ ...baseInput, predicateVocab: ['address'] }),
    );
  });

  it('is order-independent within predicateVocab', () => {
    expect(
      svc.computeKey({ ...baseInput, predicateVocab: ['x', 'y', 'z'] }),
    ).toBe(svc.computeKey({ ...baseInput, predicateVocab: ['z', 'y', 'x'] }));
  });

  it('ignores `now` when message has no temporal', () => {
    expect(svc.computeKey({ ...baseInput, hasTemporal: false })).toBe(
      svc.computeKey({
        ...baseInput,
        hasTemporal: false,
        now: new Date('2030-01-01T00:00:00Z'),
      }),
    );
  });

  it('binds key to day-bucket when message has temporal', () => {
    const k1 = svc.computeKey({
      ...baseInput,
      hasTemporal: true,
      now: new Date('2026-06-14T10:00:00Z'),
    });
    const k2 = svc.computeKey({
      ...baseInput,
      hasTemporal: true,
      now: new Date('2026-06-15T10:00:00Z'),
    });
    expect(k1).not.toBe(k2);
  });

  it('shares key within same UTC day when message has temporal', () => {
    const k1 = svc.computeKey({
      ...baseInput,
      hasTemporal: true,
      now: new Date('2026-06-14T00:30:00Z'),
    });
    const k2 = svc.computeKey({
      ...baseInput,
      hasTemporal: true,
      now: new Date('2026-06-14T23:30:00Z'),
    });
    expect(k1).toBe(k2);
  });

  it('NFC-normalizes message text', () => {
    const composed = 'café';
    const decomposed = 'café';
    expect(composed).not.toBe(decomposed);
    expect(
      svc.computeKey({ ...baseInput, message: composed }),
    ).toBe(svc.computeKey({ ...baseInput, message: decomposed }));
  });
});

describe('ChatRouterCacheService get/set', () => {
  it('returns undefined on miss, the stored route on hit', () => {
    const svc = new ChatRouterCacheService(mkConfig());
    const key = svc.computeKey(baseInput);
    expect(svc.get(key)).toBeUndefined();
    svc.set(key, stubRoute);
    expect(svc.get(key)).toBe(stubRoute);
  });

  it('disabled cache always misses and never stores', () => {
    const svc = new ChatRouterCacheService(
      mkConfig({ CHAT_ROUTE_CACHE_ENABLED: 'false' }),
    );
    const key = svc.computeKey(baseInput);
    svc.set(key, stubRoute);
    expect(svc.get(key)).toBeUndefined();
    expect(svc.stats().enabled).toBe(false);
  });

  it('tracks hit/miss counts in stats', () => {
    const svc = new ChatRouterCacheService(mkConfig());
    const key = svc.computeKey(baseInput);
    svc.get(key); // miss
    svc.set(key, stubRoute);
    svc.get(key); // hit
    svc.get(key); // hit
    const s = svc.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3, 5);
  });

  it('LRU evicts oldest entry past capacity', () => {
    const svc = new ChatRouterCacheService(
      mkConfig({ CHAT_ROUTE_CACHE_SIZE: '2' }),
    );
    const k1 = svc.computeKey({ ...baseInput, message: 'one' });
    const k2 = svc.computeKey({ ...baseInput, message: 'two' });
    const k3 = svc.computeKey({ ...baseInput, message: 'three' });
    svc.set(k1, stubRoute);
    svc.set(k2, stubRoute);
    svc.set(k3, stubRoute); // evicts k1
    expect(svc.get(k1)).toBeUndefined();
    expect(svc.get(k2)).toBe(stubRoute);
    expect(svc.get(k3)).toBe(stubRoute);
  });
});
