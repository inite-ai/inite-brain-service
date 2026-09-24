import { RemoteBgeM3 } from '../src/ai/embedder/bge-m3-remote';
import { BgeM3EmbedderProvider } from '../src/ai/embedder/bge-m3-embedder.provider';

/**
 * bge-m3 over HTTP: the ingest path fans a document's facts out one embed
 * at a time, and on the 2-vCPU droplet 101 of them queued for 51 s. The
 * remote runtime is only worth having if those calls travel as ONE request,
 * if a response outside the declared space is refused rather than stored,
 * and if a remote outage hands the work to the local model instead of
 * failing the write.
 */
const DIM = 4;

/** A fake endpoint: the vector of text `t` is [len, 1, 0, 0]; every request recorded. */
function fakeEndpoint(opts: { fail?: boolean; width?: number; shuffle?: boolean } = {}) {
  const requests: string[][] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    requests.push(input);
    if (opts.fail) return new Response('upstream down', { status: 502 });
    let data = input.map((t, index) => ({
      index,
      embedding: Array.from({ length: opts.width ?? DIM }, (_, i) =>
        i === 0 ? t.length : i === 1 ? 1 : 0,
      ),
    }));
    if (opts.shuffle) data = [...data].reverse();
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const remote = (f: ReturnType<typeof fakeEndpoint>, extra: Partial<{ maxBatch: number }> = {}) =>
  new RemoteBgeM3({
    url: 'https://example.test/v1/embeddings',
    apiKey: 'k',
    model: 'baai/bge-m3',
    dim: DIM,
    windowMs: 5,
    fetchImpl: f.fetchImpl,
    ...extra,
  });

describe('RemoteBgeM3', () => {
  it('coalesces concurrent single embeds into one request, identical texts sent once', async () => {
    const f = fakeEndpoint();
    const r = remote(f);
    const texts = ['a', 'bb', 'ccc', 'bb', 'a'];
    const vectors = await Promise.all(texts.map((t) => r.embed(t)));
    expect(f.requests).toEqual([['a', 'bb', 'ccc']]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 2, 1]);
  });

  it('splits at maxBatch and keeps every caller on its own vector', async () => {
    const f = fakeEndpoint();
    const r = remote(f, { maxBatch: 2 });
    const vectors = await Promise.all(['a', 'bb', 'ccc', 'dddd', 'eeeee'].map((t) => r.embed(t)));
    expect(f.requests.map((q) => q.length)).toEqual([2, 2, 1]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('restores input order when the endpoint answers out of order', async () => {
    const f = fakeEndpoint({ shuffle: true });
    const out = await remote(f).embedBatch(['a', 'bb', 'ccc']);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it('refuses a vector outside the declared space instead of storing it', async () => {
    const f = fakeEndpoint({ width: 8 });
    await expect(remote(f).embedBatch(['a'])).rejects.toThrow(/not 4 finite numbers/);
  });

  it('rejects every waiter of a failed request', async () => {
    const f = fakeEndpoint({ fail: true });
    const r = remote(f);
    const settled = await Promise.allSettled([r.embed('a'), r.embed('b')]);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(String((settled[0] as PromiseRejectedResult).reason)).toContain('502');
  });
});

describe('BgeM3EmbedderProvider with a remote runtime', () => {
  const space = { provider: 'bge-m3', model: 'Xenova/bge-m3', dim: DIM, norm: 'l2' } as const;
  const localVector = [9, 9, 9, 9];

  it('serves from the remote while the local model is still cold — and still wants warming', async () => {
    const f = fakeEndpoint();
    const p = new BgeM3EmbedderProvider({ space, concurrency: 2, remote: remote(f) });
    expect(p.isReady()).toBe(true);
    expect(p.needsWarmup()).toBe(true);
    expect((await p.embed('abc'))[0]).toBe(3);
  });

  it('a remote failure hands the work to the local model and keeps it there for the cooldown', async () => {
    const f = fakeEndpoint({ fail: true });
    const p = new BgeM3EmbedderProvider({
      space,
      concurrency: 2,
      remote: remote(f),
      remoteCooldownMs: 60_000,
    });
    p.setPipelineForTesting(async () => ({ data: Float32Array.from(localVector) }));
    expect(await p.embed('abc')).toEqual(localVector);
    expect(await p.embed('def')).toEqual(localVector);
    // The breaker is open: the second embed never reached the endpoint.
    expect(f.requests).toHaveLength(1);
    expect(p.needsWarmup()).toBe(false);
  });

  it('with no local model to fall back to, a remote failure is the caller’s error', async () => {
    const f = fakeEndpoint({ fail: true });
    const p = new BgeM3EmbedderProvider({ space, concurrency: 2, remote: remote(f) });
    await expect(p.embed('abc')).rejects.toThrow('502');
  });

  it('embedMany keeps empty texts as zero vectors in their places', async () => {
    const f = fakeEndpoint();
    const p = new BgeM3EmbedderProvider({ space, concurrency: 2, remote: remote(f) });
    const out = await p.embedMany(['ab', '  ', 'abcd']);
    expect(out.map((v) => v[0])).toEqual([2, 0, 4]);
    expect(out[1]).toEqual([0, 0, 0, 0]);
    expect(f.requests).toEqual([['ab', 'abcd']]);
  });
});
