/**
 * EmbedderService warmup lifecycle (review 2026-09-09, V-1).
 *
 * A failed primary warmup used to be terminal: one attempt at module init,
 * error swallowed, nothing retried — under the strict-space guard every
 * embed then answered 503 for the life of the process while /health stayed
 * green. These pin the retry loop: backoff between attempts, no stacked
 * attempts, re-arm from a readiness poll after a worker dies, and a clean
 * stop on module destroy.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { EmbedderService } from '../src/ai/embedder.service';
import type { EmbedderProvider } from '../src/ai/embedder/embedder-provider.interface';

const BGE_SPACE = 'bge-m3:Xenova/bge-m3:1024:l2';

interface FlakyPrimary extends EmbedderProvider {
  warmup: jest.Mock<Promise<void>, []>;
  /** Simulate the inference worker dying after a successful warmup. */
  die(): void;
}

/** A bge-shaped primary whose first N warmups fail, then succeed. */
function flakyPrimary(failuresBeforeReady: number): FlakyPrimary {
  let ready = false;
  let attempts = 0;
  return {
    providerId: 'bge-m3:Xenova/bge-m3:1024',
    getDimensions: () => 1024,
    isReady: () => ready,
    embed: async () => new Array(1024).fill(0.1),
    warmup: jest.fn(async () => {
      // A real model load yields to the event loop; a mock that flips
      // ready synchronously would let the very call that re-armed the
      // warmup see it complete.
      await Promise.resolve();
      attempts += 1;
      if (attempts <= failuresBeforeReady) {
        throw new Error(`HF download failed (attempt ${attempts})`);
      }
      ready = true;
    }),
    die: () => {
      ready = false;
    },
  };
}

const openai: EmbedderProvider = {
  providerId: 'openai:text-embedding-3-small:1536',
  getDimensions: () => 1536,
  isReady: () => true,
  embed: async () => new Array(1536).fill(0.2),
};

function mkSvc(
  primary: EmbedderProvider,
  fallback: EmbedderProvider | null = openai,
): EmbedderService {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      if (k === 'EMBEDDING_CACHE_SIZE') return '50';
      if (k === 'EMBEDDER_PROVIDER') return 'openai';
      return def;
    },
    getOrThrow: () => 'sk-test-stub',
  } as never;
  const svc = new EmbedderService(config);
  const inner = svc as unknown as {
    primary: EmbedderProvider;
    fallback: EmbedderProvider | null;
    primarySpaceIdValue: string;
  };
  inner.primary = primary;
  inner.fallback = fallback;
  inner.primarySpaceIdValue = BGE_SPACE;
  return svc;
}

/** Let the warmup promise chain settle without moving the clock. */
const flush = () => jest.advanceTimersByTimeAsync(0);

describe('EmbedderService warmup retry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries a failed warmup with exponential backoff until the primary is ready', async () => {
    const primary = flakyPrimary(2);
    const svc = mkSvc(primary);
    await svc.onModuleInit();
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(1);
    expect(svc.isReady()).toBe(false);
    expect(svc.warmupStatus()).toMatchObject({ ready: false, failures: 1, inFlight: false });
    expect(svc.warmupStatus().lastError).toMatch(/attempt 1/);
    expect(svc.warmupStatus().nextRetryAt).toBeDefined();

    // First retry lands at 5s, not before.
    await jest.advanceTimersByTimeAsync(4_999);
    expect(primary.warmup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(2);
    expect(svc.warmupStatus().failures).toBe(2);

    // Second retry doubles to 10s and succeeds.
    await jest.advanceTimersByTimeAsync(9_999);
    expect(primary.warmup).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(3);
    expect(svc.isReady()).toBe(true);
    expect(svc.warmupStatus()).toEqual({ ready: true, failures: 0, inFlight: false });
    await svc.onModuleDestroy();
  });

  it('caps the retry interval at five minutes', async () => {
    const primary = flakyPrimary(20);
    const svc = mkSvc(primary);
    await svc.onModuleInit();
    await flush();
    // 5s, 10s, 20s, 40s, 80s, 160s, then 300s cap: seven failures in.
    for (const wait of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000]) {
      await jest.advanceTimersByTimeAsync(wait);
      await flush();
    }
    expect(primary.warmup).toHaveBeenCalledTimes(7);
    await jest.advanceTimersByTimeAsync(299_999);
    expect(primary.warmup).toHaveBeenCalledTimes(7);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(8);
    await svc.onModuleDestroy();
  });

  it('never stacks a second attempt while one is in flight', async () => {
    let ready = false;
    let release!: () => void;
    const primary: EmbedderProvider = {
      providerId: 'bge-m3:Xenova/bge-m3:1024',
      getDimensions: () => 1024,
      isReady: () => ready,
      embed: async () => new Array(1024).fill(0.1),
      warmup: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              ready = true;
              resolve();
            };
          }),
      ),
    };
    const svc = mkSvc(primary);
    await svc.onModuleInit();
    // Readiness polls and embed attempts during the load must not spawn
    // more loads.
    expect(svc.isReady()).toBe(false);
    expect(svc.isReady()).toBe(false);
    await expect(svc.embed('x')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(primary.warmup).toHaveBeenCalledTimes(1);
    expect(svc.warmupStatus().inFlight).toBe(true);
    release();
    await flush();
    expect(svc.isReady()).toBe(true);
    expect(svc.warmupStatus().inFlight).toBe(false);
    await svc.onModuleDestroy();
  });

  it('refuses embeds under the strict guard while warming, serves the primary once retried', async () => {
    const primary = flakyPrimary(1);
    const svc = mkSvc(primary);
    await svc.onModuleInit();
    await flush();
    // The OpenAI fallback is in an incompatible space: refuse, do not
    // answer 1536-wide against a 1024-wide corpus.
    await expect(svc.embed('cats')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();
    await expect(svc.embed('cats')).resolves.toHaveLength(1024);
    await svc.onModuleDestroy();
  });

  it('a readiness poll re-arms warmup after the worker dies mid-life', async () => {
    const primary = flakyPrimary(0);
    const svc = mkSvc(primary);
    await svc.onModuleInit();
    await flush();
    expect(svc.isReady()).toBe(true);
    primary.die();
    // No failure on record, so the re-arm is immediate.
    expect(svc.isReady()).toBe(false);
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(2);
    expect(svc.isReady()).toBe(true);
    await svc.onModuleDestroy();
  });

  it('the embed path re-arms warmup too', async () => {
    const primary = flakyPrimary(0);
    const svc = mkSvc(primary);
    await svc.onModuleInit();
    await flush();
    primary.die();
    await expect(svc.embed('cats')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(2);
    await expect(svc.embed('cats')).resolves.toHaveLength(1024);
    await svc.onModuleDestroy();
  });

  it('stops retrying once the module is destroyed', async () => {
    const primary = flakyPrimary(100);
    const svc = mkSvc(primary);
    await svc.onModuleInit();
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(svc.isReady()).toBe(false);
    await flush();
    expect(primary.warmup).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a primary that has no warmup (openai)', async () => {
    const svc = mkSvc(openai, null);
    (svc as unknown as { primarySpaceIdValue: string }).primarySpaceIdValue =
      'openai:text-embedding-3-small:1536:l2';
    await svc.onModuleInit();
    await flush();
    expect(svc.isReady()).toBe(true);
    expect(svc.warmupStatus()).toEqual({ ready: true, failures: 0, inFlight: false });
    await svc.onModuleDestroy();
  });
});
