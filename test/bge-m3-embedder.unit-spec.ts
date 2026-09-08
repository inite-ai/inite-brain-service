import { BgeM3EmbedderProvider } from '../src/ai/embedder/bge-m3-embedder.provider';
import { declaredSpace } from '../src/ai/embedder/embedding-space';

/** A space literal for the truncation/padding cases, which deliberately
 *  use a tiny width. Production widths come from `declaredSpace`. */
const space = (model: string, dim: number) =>
  ({ provider: 'bge-m3', model, dim, norm: 'l2' }) as const;

describe('BgeM3EmbedderProvider', () => {
  it('reports providerId encoding model + dim', () => {
    const p = new BgeM3EmbedderProvider({
      space: declaredSpace('bge-m3'),
      concurrency: 4,
    });
    expect(p.providerId).toBe('bge-m3:Xenova/bge-m3:1024');
  });

  it('is not ready until the pipeline is set', () => {
    const p = new BgeM3EmbedderProvider({
      space: declaredSpace('bge-m3'),
      concurrency: 4,
    });
    expect(p.isReady()).toBe(false);
  });

  it('throws when embed() is called before warmup completes', async () => {
    const p = new BgeM3EmbedderProvider({
      space: declaredSpace('bge-m3'),
      concurrency: 4,
    });
    await expect(p.embed('hello')).rejects.toThrow(/not ready/);
  });

  it('returns the zero vector for empty input', async () => {
    const p = new BgeM3EmbedderProvider({
      space: space('Xenova/bge-m3', 8),
      concurrency: 2,
    });
    p.setPipelineForTesting(async () => ({ data: new Float32Array(8).fill(0.5) }));
    const v = await p.embed('');
    expect(v).toEqual(new Array(8).fill(0));
  });

  it('truncates an oversized model output to configured dim', async () => {
    const p = new BgeM3EmbedderProvider({
      space: space('m', 4),
      concurrency: 2,
    });
    p.setPipelineForTesting(async () => ({
      data: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    }));
    const v = await p.embed('text');
    expect(v).toEqual([1, 2, 3, 4]);
  });

  it('zero-pads an undersized model output up to configured dim', async () => {
    const p = new BgeM3EmbedderProvider({
      space: space('m', 6),
      concurrency: 2,
    });
    p.setPipelineForTesting(async () => ({
      data: Float32Array.from([1, 2, 3]),
    }));
    const v = await p.embed('text');
    expect(v).toEqual([1, 2, 3, 0, 0, 0]);
  });
});
