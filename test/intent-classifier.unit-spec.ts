/**
 * Unit-test for IntentClassifierService — punctuation fast-path,
 * NLI primary path, cache, fallback.
 */
import { ConfigService } from '@nestjs/config';
import { IntentClassifierService } from '../src/admin/intent-classifier.service';

function mkConfig(over: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    CHAT_ROUTE_NLI_ENABLED: 'true',
    CHAT_ROUTE_NLI_ASK_THRESHOLD: '0.6',
    ...over,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

 
type MockPipeline = jest.Mock<any, any>;

function mkPipeline(qScore: number, sScore = 1 - qScore): MockPipeline {
  return jest.fn(async (text: string) => ({
    sequence: text,
    labels: ['question', 'statement'],
    scores: [qScore, sScore],
  }));
}

describe('IntentClassifierService — punctuation paths (no NLI)', () => {
  it('empty / whitespace → tell, 0', async () => {
    const svc = new IntentClassifierService(mkConfig());
    await expect(svc.classify('')).resolves.toEqual({
      intent: 'tell',
      confidence: 0,
      source: 'punctuation',
    });
    await expect(svc.classify('   ')).resolves.toEqual({
      intent: 'tell',
      confidence: 0,
      source: 'punctuation',
    });
  });

  it('trailing `?` → ask, 0.95 (never invokes NLI)', async () => {
    const svc = new IntentClassifierService(mkConfig());
    const pipe = mkPipeline(0.99);
    svc.setClassifierForTesting(pipe);
    await expect(svc.classify('Where lives Maria?')).resolves.toEqual({
      intent: 'ask',
      confidence: 0.95,
      source: 'punctuation',
    });
    expect(pipe).not.toHaveBeenCalled();
  });

  it('no `?`, classifier not ready → tell, 0.7', async () => {
    const svc = new IntentClassifierService(mkConfig());
    expect(svc.isReady()).toBe(false);
    await expect(svc.classify('Maria moved to Berlin')).resolves.toEqual({
      intent: 'tell',
      confidence: 0.7,
      source: 'punctuation',
    });
  });
});

describe('IntentClassifierService — NLI primary path', () => {
  it('no `?`, NLI says ask above threshold → ask + nli source', async () => {
    const svc = new IntentClassifierService(mkConfig());
    const pipe = mkPipeline(0.82);
    svc.setClassifierForTesting(pipe);
    const result = await svc.classify('where Maria lives');
    expect(result).toEqual({
      intent: 'ask',
      confidence: 0.82,
      source: 'nli',
    });
    expect(pipe).toHaveBeenCalledTimes(1);
    expect(pipe.mock.calls[0][1]).toEqual(['question', 'statement']);
  });

  it('no `?`, NLI says ask below threshold → tell + nli source', async () => {
    const svc = new IntentClassifierService(
      mkConfig({ CHAT_ROUTE_NLI_ASK_THRESHOLD: '0.7' }),
    );
    const pipe = mkPipeline(0.55);
    svc.setClassifierForTesting(pipe);
    const result = await svc.classify('Maria moved to Berlin');
    expect(result).toEqual({
      intent: 'tell',
      confidence: 1 - 0.55,
      source: 'nli',
    });
  });

  it('caches NLI result; repeat call returns source=cache', async () => {
    const svc = new IntentClassifierService(mkConfig());
    const pipe = mkPipeline(0.8);
    svc.setClassifierForTesting(pipe);
    const first = await svc.classify('repeated question without mark');
    expect(first.source).toBe('nli');
    const second = await svc.classify('repeated question without mark');
    expect(second).toEqual({
      intent: 'ask',
      confidence: 0.8,
      source: 'cache',
    });
    expect(pipe).toHaveBeenCalledTimes(1);
  });

  it('NLI throws → silent fallback to punctuation', async () => {
    const svc = new IntentClassifierService(mkConfig());
    const pipe: MockPipeline = jest.fn(async () => {
      throw new Error('boom');
    });
    svc.setClassifierForTesting(pipe);
    const result = await svc.classify('arbitrary statement');
    expect(result).toEqual({
      intent: 'tell',
      confidence: 0.7,
      source: 'punctuation',
    });
  });

  it('stats() exposes ready/enabled/model/threshold/cacheSize for observability', async () => {
    const svc = new IntentClassifierService(
      mkConfig({
        CHAT_ROUTE_NLI_MODEL: 'Xenova/test-model',
        CHAT_ROUTE_NLI_ASK_THRESHOLD: '0.55',
      }),
    );
    const cold = svc.stats();
    expect(cold).toEqual({
      enabled: true,
      ready: false,
      model: 'Xenova/test-model',
      askThreshold: 0.55,
      cacheSize: 0,
    });
    svc.setClassifierForTesting(mkPipeline(0.9));
    await svc.classify('warm one');
    const warm = svc.stats();
    expect(warm.ready).toBe(true);
    expect(warm.cacheSize).toBe(1);
  });

  it('threshold tunable via CHAT_ROUTE_NLI_ASK_THRESHOLD', async () => {
    const strict = new IntentClassifierService(
      mkConfig({ CHAT_ROUTE_NLI_ASK_THRESHOLD: '0.9' }),
    );
    strict.setClassifierForTesting(mkPipeline(0.85));
    expect((await strict.classify('borderline q')).intent).toBe('tell');

    const loose = new IntentClassifierService(
      mkConfig({ CHAT_ROUTE_NLI_ASK_THRESHOLD: '0.5' }),
    );
    loose.setClassifierForTesting(mkPipeline(0.55));
    expect((await loose.classify('borderline q')).intent).toBe('ask');
  });
});
