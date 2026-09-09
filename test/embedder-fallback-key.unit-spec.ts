import { ServiceUnavailableException } from '@nestjs/common';
import { EmbedderService } from '../src/ai/embedder.service';

/**
 * V-8 of the #501-wave review: a bge-m3 deployment used to REQUIRE
 * OPENAI_API_KEY at boot (`getOrThrow`) for a fallback provider that, under
 * the default-on strict space guard, can never serve a 1024-wide corpus —
 * the boot refused for a key the process would not use. The key is now
 * required only when OpenAI is the PRIMARY; without it the bge-m3 primary
 * runs with no fallback, and a not-ready primary answers the same 503 the
 * guard produces rather than the provider's bare Error (a 500).
 */

interface FakeProvider {
  providerId: string;
  getDimensions(): number;
  isReady(): boolean;
  embed(t: string): Promise<number[]>;
  embedMany(t: string[]): Promise<number[][]>;
}

const bge = (ready: boolean): FakeProvider => ({
  providerId: 'bge-m3:Xenova/bge-m3:1024',
  getDimensions: () => 1024,
  isReady: () => ready,
  embed: async () => new Array(1024).fill(0.1),
  embedMany: async (t) => t.map(() => new Array(1024).fill(0.1)),
});

function config(opts: { provider: 'bge-m3' | 'openai'; key: string | undefined }) {
  return {
    get: (k: string, def?: string) => {
      if (k === 'EMBEDDER_PROVIDER') return opts.provider;
      if (k === 'OPENAI_API_KEY') return opts.key;
      if (k === 'EMBEDDING_CACHE_SIZE') return '50';
      return def;
    },
    getOrThrow: (k: string) => {
      if (k === 'OPENAI_API_KEY' && opts.key) return opts.key;
      throw new Error(`Configuration key "${k}" does not exist`);
    },
  } as never;
}

const inner = (svc: EmbedderService) =>
  svc as unknown as { primary: FakeProvider; fallback: FakeProvider | null };

describe('EmbedderService — OPENAI_API_KEY is required only where OpenAI can serve', () => {
  it('bge-m3 primary WITHOUT a key boots, with no fallback', () => {
    const svc = new EmbedderService(config({ provider: 'bge-m3', key: undefined }));
    expect(inner(svc).fallback).toBeNull();
    expect(svc.primarySpaceId()).toBe('bge-m3:Xenova/bge-m3:1024:l2');
  });

  it('bge-m3 primary WITH a key keeps the OpenAI fallback for the warmup window', () => {
    const svc = new EmbedderService(config({ provider: 'bge-m3', key: 'sk-test-stub' }));
    expect(inner(svc).fallback).not.toBeNull();
  });

  it('openai primary WITHOUT a key is still the canonical configuration error at construction', () => {
    expect(() => new EmbedderService(config({ provider: 'openai', key: undefined }))).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('no fallback + primary not ready → 503, not the provider\'s bare "not ready" Error', async () => {
    const svc = new EmbedderService(config({ provider: 'bge-m3', key: undefined }));
    inner(svc).primary = bge(false);
    await expect(svc.embed('hello')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.embed('hello')).rejects.toThrow(/not ready and no fallback/);
    // The write path answers the same way — a doomed batch costs no inference.
    await expect(svc.embedManyForWrite(['a', 'b'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('no fallback + primary ready → serves from the primary', async () => {
    const svc = new EmbedderService(config({ provider: 'bge-m3', key: undefined }));
    inner(svc).primary = bge(true);
    expect((await svc.embed('hello')).length).toBe(1024);
  });
});
