import { ConfigService } from '@nestjs/config';
import { CrossEncoderService } from '../src/ai/cross-encoder.service';

/**
 * Unit coverage for the Cohere cross-encoder capability. We only test
 * the in-process behaviour (capability gating, fallback shape) — the
 * happy path requires a live Cohere endpoint and is exercised by the
 * quality eval when COHERE_API_KEY is set in CI.
 */
describe('CrossEncoderService', () => {
  function svc(env: Record<string, string | undefined>): CrossEncoderService {
    const cfg = {
      get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
    } as unknown as ConfigService;
    return new CrossEncoderService(cfg);
  }

  it('reports disabled with neither a Cohere key nor a local provider', () => {
    expect(svc({}).isEnabled()).toBe(false);
  });

  it('reports enabled when the vendor key is present (capability)', () => {
    expect(svc({ COHERE_API_KEY: 'k' }).isEnabled()).toBe(true);
  });

  it('returns identity when disabled', async () => {
    const s = svc({});
    const out = await s.rerank('q', [
      { label: 'a', body: 'x' },
      { label: 'b', body: 'y' },
      { label: 'c', body: 'z' },
    ]);
    expect(out).toEqual([0, 1, 2]);
  });

  it('returns identity for ≤1 candidate even when enabled', async () => {
    const s = svc({
      COHERE_API_KEY: 'k',
    });
    expect(await s.rerank('q', [])).toEqual([]);
    expect(await s.rerank('q', [{ label: 'only', body: '' }])).toEqual([0]);
  });

  it('returns identity on empty / whitespace query', async () => {
    const s = svc({
      COHERE_API_KEY: 'k',
    });
    expect(
      await s.rerank('   ', [
        { label: 'a', body: 'x' },
        { label: 'b', body: 'y' },
      ]),
    ).toEqual([0, 1]);
  });

  it('returns identity on HTTP failure', async () => {
    const original = global.fetch;
    global.fetch = (async () => new Response('bad', { status: 500 })) as typeof fetch;
    try {
      const s = svc({
        COHERE_API_KEY: 'k',
      });
      const out = await s.rerank('q', [
        { label: 'a', body: 'x' },
        { label: 'b', body: 'y' },
      ]);
      expect(out).toEqual([0, 1]);
    } finally {
      global.fetch = original;
    }
  });

  it('returns identity on malformed JSON shape', async () => {
    const original = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ wrong: 'shape' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const s = svc({
        COHERE_API_KEY: 'k',
      });
      const out = await s.rerank('q', [
        { label: 'a', body: 'x' },
        { label: 'b', body: 'y' },
      ]);
      expect(out).toEqual([0, 1]);
    } finally {
      global.fetch = original;
    }
  });

  it('parses a valid Cohere response into a permutation', async () => {
    const original = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.5 },
            { index: 1, relevance_score: 0.1 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      const s = svc({
        COHERE_API_KEY: 'k',
      });
      const out = await s.rerank('q', [
        { label: 'a', body: 'x' },
        { label: 'b', body: 'y' },
        { label: 'c', body: 'z' },
      ]);
      expect(out).toEqual([2, 0, 1]);
    } finally {
      global.fetch = original;
    }
  });

  it('fills missing indices when Cohere returns a partial subset', async () => {
    const original = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [{ index: 1, relevance_score: 0.9 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      const s = svc({
        COHERE_API_KEY: 'k',
      });
      const out = await s.rerank('q', [
        { label: 'a', body: 'x' },
        { label: 'b', body: 'y' },
        { label: 'c', body: 'z' },
      ]);
      // Ranked subset first, then untouched indices in original order.
      expect(out).toEqual([1, 0, 2]);
    } finally {
      global.fetch = original;
    }
  });

  it('returns identity when response contains a duplicate index', async () => {
    const original = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.5 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      const s = svc({
        COHERE_API_KEY: 'k',
      });
      const out = await s.rerank('q', [
        { label: 'a', body: 'x' },
        { label: 'b', body: 'y' },
      ]);
      expect(out).toEqual([0, 1]);
    } finally {
      global.fetch = original;
    }
  });
});
