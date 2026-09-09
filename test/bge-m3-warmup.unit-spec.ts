/**
 * BgeM3EmbedderProvider warmup contract (review 2026-09-09, V-1).
 *
 * `warmup()` must REJECT when the model cannot be loaded — the owner's
 * retry loop can only act on a failure it is told about — and must be
 * callable again afterwards.
 */
import { BgeM3EmbedderProvider } from '../src/ai/embedder/bge-m3-embedder.provider';
import { declaredSpace } from '../src/ai/embedder/embedding-space';

const readyPipeline = async () => ({ data: new Float32Array(1024).fill(0.5) });

describe('BgeM3EmbedderProvider.warmup', () => {
  it('rejects when the model cannot be loaded and leaves the provider not-ready', async () => {
    const provider = new BgeM3EmbedderProvider({
      space: declaredSpace('bge-m3'),
      concurrency: 1,
      useWorker: false,
      loadPipeline: async () => {
        throw new Error('ENOTFOUND huggingface.co');
      },
    });
    await expect(provider.warmup()).rejects.toThrow(/BGE-M3 warmup failed.*ENOTFOUND/);
    expect(provider.isReady()).toBe(false);
    await expect(provider.embed('cats')).rejects.toThrow(/not ready/);
  });

  it('a later warmup succeeds and flips the provider ready', async () => {
    let calls = 0;
    const provider = new BgeM3EmbedderProvider({
      space: declaredSpace('bge-m3'),
      concurrency: 1,
      useWorker: false,
      loadPipeline: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return readyPipeline;
      },
    });
    await expect(provider.warmup()).rejects.toThrow(/transient/);
    await expect(provider.warmup()).resolves.toBeUndefined();
    expect(provider.isReady()).toBe(true);
    await expect(provider.embed('cats')).resolves.toHaveLength(1024);
  });
});
