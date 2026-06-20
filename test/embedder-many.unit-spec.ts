/**
 * Unit-test for EmbedderService.embedMany — verifies:
 *   - batched API short-circuits empty/whitespace to the zero vector
 *   - cached entries skip the provider call
 *   - cache-misses go through provider.embedMany (when available)
 *   - results are stitched back to input order
 */
import { EmbedderService } from '../src/ai/embedder.service';

function mkSvc(opts: {
  providerId?: string;
  embedManyMock?: (texts: string[]) => Promise<number[][]>;
}): EmbedderService {
  // We can't easily DI a fake EmbedderProvider through the public
  // EmbedderService constructor (it builds providers itself), so we
  // construct one and replace the private `primary`.
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      if (k === 'OPENAI_EMBEDDING_DIMENSIONS') return '4';
      if (k === 'EMBEDDING_CACHE_SIZE') return '50';
      if (k === 'EMBEDDER_PROVIDER') return 'openai';
      return def;
    },
    getOrThrow: (k: string) => {
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      throw new Error(`getOrThrow missing: ${k}`);
    },
  } as any;
  const svc = new EmbedderService(config);
  const fake = {
    providerId: opts.providerId ?? 'openai:fake:4',
    getDimensions: () => 4,
    isReady: () => true,
    embed: async () => [0, 0, 0, 0],
    embedMany:
      opts.embedManyMock ??
      (async (texts: string[]) => texts.map((_, i) => [i, i, i, i])),
  } as any;
  (svc as any).primary = fake;
  (svc as any).fallback = null;
  return svc;
}

describe('EmbedderService.embedMany', () => {
  it('returns empty array for empty input', async () => {
    const svc = mkSvc({});
    const r = await svc.embedMany([]);
    expect(r).toEqual([]);
  });

  it('emits zero-vectors for whitespace inputs without hitting the provider', async () => {
    let calls = 0;
    const svc = mkSvc({
      embedManyMock: async (t) => {
        calls += 1;
        return t.map(() => [9, 9, 9, 9]);
      },
    });
    const r = await svc.embedMany(['  ', '\n', '']);
    expect(calls).toBe(0);
    for (const v of r) expect(v).toEqual([0, 0, 0, 0]);
  });

  it('batches cache-missed entries through provider.embedMany', async () => {
    const seen: string[][] = [];
    const svc = mkSvc({
      embedManyMock: async (t) => {
        seen.push(t);
        return t.map((_, i) => [i + 1, i + 1, i + 1, i + 1]);
      },
    });
    const r = await svc.embedMany(['a', 'b', 'c']);
    expect(seen).toEqual([['a', 'b', 'c']]);
    expect(r).toEqual([
      [1, 1, 1, 1],
      [2, 2, 2, 2],
      [3, 3, 3, 3],
    ]);
  });

  it('serves cached entries without re-asking the provider', async () => {
    let calls = 0;
    const svc = mkSvc({
      embedManyMock: async (t) => {
        calls += 1;
        return t.map(() => [7, 7, 7, 7]);
      },
    });
    await svc.embedMany(['a', 'b']);
    expect(calls).toBe(1);
    const r2 = await svc.embedMany(['a', 'c']);
    // 'a' hit, only 'c' missed
    expect(calls).toBe(2);
    expect(r2[0]).toEqual([7, 7, 7, 7]);
    expect(r2[1]).toEqual([7, 7, 7, 7]);
  });

  it('preserves original input order across mixed hit/miss/empty', async () => {
    const svc = mkSvc({
      embedManyMock: async (t) =>
        t.map((s) => [s.length, s.length, s.length, s.length]),
    });
    // Prime: cache 'cached'
    await svc.embedMany(['cached']);
    const r = await svc.embedMany(['', 'cached', 'fresh', '  ']);
    expect(r).toHaveLength(4);
    expect(r[0]).toEqual([0, 0, 0, 0]);
    expect(r[1]).toEqual([6, 6, 6, 6]);
    expect(r[2]).toEqual([5, 5, 5, 5]);
    expect(r[3]).toEqual([0, 0, 0, 0]);
  });
});
