/**
 * IntentClassifierService warmup lifecycle.
 *
 * The default model repo went gated on the Hub (HTTP 401), and the
 * classifier answered by retrying every five minutes for the life of the
 * process while the health grid said "warming". These pin: the default is
 * a public repo; a failed warmup backs off (5m, doubling, capped at 1h) on a
 * timer; a gated/missing repo starts at the ceiling; and the bookkeeping the
 * grid renders carries the reason. The in-thread path is driven with the
 * transformers module mocked — no model is ever downloaded.
 */
import { ConfigService } from '@nestjs/config';

const mockPipeline = jest.fn<Promise<unknown>, [string, string]>();

jest.mock('@xenova/transformers', () => ({
  env: {},
  pipeline: (task: string, modelId: string) => mockPipeline(task, modelId),
}));

import { IntentClassifierService } from '../src/admin/intent-classifier.service';

const PUBLIC_DEFAULT = 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7';
const MINUTE = 60_000;

function mkConfig(over: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    CHAT_ROUTE_NLI_ENABLED: 'true',
    CHAT_ROUTE_NLI_WORKER: '0',
    ...over,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

/** A pipeline load that fails `failuresBeforeReady` times, then serves. */
function flakyLoad(
  failuresBeforeReady: number,
  message = (n: number) => `HF download failed (attempt ${n})`,
) {
  let attempts = 0;
  mockPipeline.mockImplementation(async () => {
    await Promise.resolve();
    attempts += 1;
    if (attempts <= failuresBeforeReady) throw new Error(message(attempts));
    return async (text: string) => ({
      sequence: text,
      labels: ['question', 'statement'],
      scores: [0.9, 0.1],
    });
  });
}

/** Let the warmup promise chain settle without moving the clock. */
const flush = () => jest.advanceTimersByTimeAsync(0);

const minutesUntilRetry = (svc: IntentClassifierService): number => {
  const at = svc.warmupStatus().nextRetryAt;
  if (!at) throw new Error('no retry scheduled');
  return (Date.parse(at) - Date.now()) / MINUTE;
};

beforeEach(() => {
  jest.useFakeTimers();
  mockPipeline.mockReset();
});
afterEach(() => jest.useRealTimers());

describe('IntentClassifierService — default model', () => {
  it('loads a public multilingual repo by default and reports it in stats()', async () => {
    flakyLoad(0);
    const svc = new IntentClassifierService(mkConfig());
    svc.onModuleInit();
    await flush();
    expect(mockPipeline).toHaveBeenCalledWith('zero-shot-classification', PUBLIC_DEFAULT);
    expect(svc.stats().model).toBe(PUBLIC_DEFAULT);
    expect(svc.isReady()).toBe(true);
    expect(svc.warmupStatus()).toEqual({ ready: true, failures: 0, inFlight: false });
    await svc.onApplicationShutdown();
  });

  it('CHAT_ROUTE_NLI_MODEL still overrides the default', async () => {
    flakyLoad(0);
    const svc = new IntentClassifierService(mkConfig({ CHAT_ROUTE_NLI_MODEL: 'Xenova/other' }));
    svc.onModuleInit();
    await flush();
    expect(mockPipeline).toHaveBeenCalledWith('zero-shot-classification', 'Xenova/other');
    await svc.onApplicationShutdown();
  });
});

describe('IntentClassifierService — warmup backoff', () => {
  it('retries on a timer with a doubling interval that caps at one hour', async () => {
    flakyLoad(100);
    const svc = new IntentClassifierService(mkConfig());
    svc.onModuleInit();
    await flush();
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(svc.isReady()).toBe(false);

    // 5m, 10m, 20m, 40m, then the 60m ceiling — and the ceiling holds.
    const expected = [5, 10, 20, 40, 60, 60, 60];
    for (const [i, minutes] of expected.entries()) {
      expect(svc.warmupStatus()).toMatchObject({ ready: false, failures: i + 1, inFlight: false });
      expect(svc.warmupStatus().lastError).toBe(`HF download failed (attempt ${i + 1})`);
      expect(minutesUntilRetry(svc)).toBe(minutes);
      // The retry is timer-driven: nothing before the boundary, one attempt on it.
      await jest.advanceTimersByTimeAsync(minutes * MINUTE - 1);
      expect(mockPipeline).toHaveBeenCalledTimes(i + 1);
      await jest.advanceTimersByTimeAsync(1);
      await flush();
      expect(mockPipeline).toHaveBeenCalledTimes(i + 2);
    }
    await svc.onApplicationShutdown();
  });

  it('a request during the backoff keeps the punctuation fallback and does not re-warm', async () => {
    flakyLoad(100);
    const svc = new IntentClassifierService(mkConfig());
    svc.onModuleInit();
    await flush();
    await expect(svc.classify('Maria moved to Berlin')).resolves.toEqual({
      intent: 'tell',
      confidence: 0.7,
      source: 'punctuation',
    });
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    await svc.onApplicationShutdown();
  });

  it('a gated or missing repo (Hub 401/403/404) starts at the ceiling and names the knob', async () => {
    flakyLoad(
      100,
      () =>
        'Unauthorized access to file: "https://huggingface.co/Xenova/gone/resolve/main/config.json".',
    );
    const svc = new IntentClassifierService(mkConfig({ CHAT_ROUTE_NLI_MODEL: 'Xenova/gone' }));
    svc.onModuleInit();
    await flush();
    const status = svc.warmupStatus();
    expect(status).toMatchObject({ ready: false, failures: 1, inFlight: false });
    expect(status.lastError).toContain('gated or removed');
    expect(status.lastError).toContain('CHAT_ROUTE_NLI_MODEL');
    expect(status.lastError).toContain('Unauthorized access to file');
    expect(minutesUntilRetry(svc)).toBe(60);
    await svc.onApplicationShutdown();
  });

  it('recovers: a later attempt succeeds, the bookkeeping clears and NLI serves', async () => {
    flakyLoad(1);
    const svc = new IntentClassifierService(mkConfig());
    svc.onModuleInit();
    await flush();
    expect(svc.warmupStatus().failures).toBe(1);
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    await flush();
    expect(svc.warmupStatus()).toEqual({ ready: true, failures: 0, inFlight: false });
    await expect(svc.classify('where Maria lives')).resolves.toEqual({
      intent: 'ask',
      confidence: 0.9,
      source: 'nli',
    });
    await svc.onApplicationShutdown();
  });

  it('reports the attempt in flight while a load runs', async () => {
    let release!: () => void;
    mockPipeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(async () => ({ sequence: '', labels: [], scores: [] }));
        }),
    );
    const svc = new IntentClassifierService(mkConfig());
    svc.onModuleInit();
    // The module import resolves in a microtask; the load itself then hangs.
    await flush();
    expect(svc.warmupStatus()).toEqual({ ready: false, failures: 0, inFlight: true });
    release();
    await flush();
    expect(svc.warmupStatus()).toEqual({ ready: true, failures: 0, inFlight: false });
    await svc.onApplicationShutdown();
  });

  it('stops retrying once the application shuts down', async () => {
    flakyLoad(100);
    const svc = new IntentClassifierService(mkConfig());
    svc.onModuleInit();
    await flush();
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    await svc.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(2 * 60 * MINUTE);
    await flush();
    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });
});
