/**
 * Unit-test for LocalNerService — opt-in flag, lazy classifier seam,
 * score filtering, cache. Model not loaded in tests; classifier is
 * injected via setClassifierForTesting.
 */
import type { ConfigService } from '@nestjs/config';
import { LocalNerService } from '../src/ai/local-ner.service';

function mkConfig(over: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    EXTRACTOR_LOCAL_NER_ENABLED: 'true',
    EXTRACTOR_LOCAL_NER_MIN_SCORE: '0.7',
    ...over,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockPipeline = jest.Mock<any, any>;

function mkPipeline(
  entities: Array<{
    word: string;
    entity_group?: string;
    start: number;
    end: number;
    score: number;
  }>,
): MockPipeline {
  return jest.fn(async () => entities);
}

describe('LocalNerService — disabled by default', () => {
  it('isReady=false until warmup completes', async () => {
    const svc = new LocalNerService(
      mkConfig({ EXTRACTOR_LOCAL_NER_ENABLED: 'false' }),
    );
    expect(svc.isReady()).toBe(false);
    await expect(svc.extract('Maria works at Acme')).resolves.toEqual([]);
  });

  it('stats reflects disabled state', () => {
    const svc = new LocalNerService(
      mkConfig({ EXTRACTOR_LOCAL_NER_ENABLED: 'false' }),
    );
    const s = svc.stats();
    expect(s.enabled).toBe(false);
    expect(s.ready).toBe(false);
  });
});

describe('LocalNerService — with mocked classifier', () => {
  it('extracts entities above min score threshold', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.setClassifierForTesting(
      mkPipeline([
        { word: 'Maria Petrov', entity_group: 'PER', start: 0, end: 12, score: 0.95 },
        { word: 'Acme', entity_group: 'ORG', start: 26, end: 30, score: 0.85 },
        { word: 'low', entity_group: 'MISC', start: 0, end: 3, score: 0.5 },
      ]),
    );
    const out = await svc.extract('Maria Petrov is CTO at Acme');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      text: 'Maria Petrov',
      type: 'PER',
      start: 0,
      end: 12,
      score: 0.95,
    });
    expect(out[1].type).toBe('ORG');
  });

  it('uppercases entity types', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.setClassifierForTesting(
      mkPipeline([
        { word: 'Berlin', entity_group: 'loc', start: 0, end: 6, score: 0.9 },
      ]),
    );
    const out = await svc.extract('Berlin');
    expect(out[0].type).toBe('LOC');
  });

  it('caches results per trimmed input', async () => {
    const svc = new LocalNerService(mkConfig());
    const pipe = mkPipeline([
      { word: 'Maria', entity_group: 'PER', start: 0, end: 5, score: 0.9 },
    ]);
    svc.setClassifierForTesting(pipe);
    await svc.extract('Maria');
    await svc.extract('Maria');
    expect(pipe).toHaveBeenCalledTimes(1);
  });

  it('falls back to [] on pipeline throw', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.setClassifierForTesting(jest.fn(async () => {
      throw new Error('boom');
    }) as MockPipeline);
    await expect(svc.extract('anything')).resolves.toEqual([]);
  });

  it('respects min score override', async () => {
    const svc = new LocalNerService(
      mkConfig({ EXTRACTOR_LOCAL_NER_MIN_SCORE: '0.99' }),
    );
    svc.setClassifierForTesting(
      mkPipeline([
        { word: 'Maria', entity_group: 'PER', start: 0, end: 5, score: 0.95 },
      ]),
    );
    await expect(svc.extract('Maria')).resolves.toEqual([]);
  });
});
