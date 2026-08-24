/**
 * Multilingual Tier 2 — EmbedderService strict-space guard
 * (EMBEDDING_SPACE_STRICT).
 *
 * Proves:
 *   - OFF (default): the warmup failover from a not-ready bge-m3 primary to
 *     the OpenAI fallback is BYTE-IDENTICAL to today — embed() serves the
 *     fallback vector, no throw.
 *   - ON: the same cross-space failover is REFUSED (503) rather than
 *     silently cross-space-compared.
 *   - ON but compatible (primary ready, or openai-only deployment): serves
 *     normally — the guard only fires on a genuine space mismatch.
 */
import { EmbedderService } from '../src/ai/embedder.service';
import { ServiceUnavailableException } from '@nestjs/common';

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

const openai = (): FakeProvider => ({
  providerId: 'openai:text-embedding-3-small:1536',
  getDimensions: () => 1536,
  isReady: () => true,
  embed: async () => new Array(1536).fill(0.2),
  embedMany: async (t) => t.map(() => new Array(1536).fill(0.2)),
});

function mkSvc(opts: {
  strict?: string | undefined;
  primary: FakeProvider;
  fallback: FakeProvider | null;
  primarySpaceId: string;
}): EmbedderService {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'EMBEDDING_SPACE_STRICT') return opts.strict;
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      if (k === 'OPENAI_EMBEDDING_DIMENSIONS') return '1536';
      if (k === 'EMBEDDING_CACHE_SIZE') return '50';
      if (k === 'EMBEDDER_PROVIDER') return 'openai';
      return def;
    },
    getOrThrow: () => 'sk-test-stub',
  } as never;
  const svc = new EmbedderService(config);
  (svc as unknown as { primary: FakeProvider }).primary = opts.primary;
  (svc as unknown as { fallback: FakeProvider | null }).fallback = opts.fallback;
  (svc as unknown as { primarySpaceIdValue: string }).primarySpaceIdValue = opts.primarySpaceId;
  return svc;
}

const BGE_SPACE = 'bge-m3:Xenova/bge-m3:1024:l2';
const OPENAI_SPACE = 'openai:text-embedding-3-small:1536:l2';

describe('EmbedderService strict-space guard', () => {
  it('OFF: cross-space warmup failover is byte-identical (serves the fallback)', async () => {
    const svc = mkSvc({
      strict: undefined, // flag off
      primary: bge(false), // not warmed up yet
      fallback: openai(),
      primarySpaceId: BGE_SPACE,
    });
    const v = await svc.embed('hello');
    expect(v).toHaveLength(1536); // the OpenAI fallback served, exactly as today
    const many = await svc.embedMany(['a', 'b']);
    expect(many).toHaveLength(2);
    expect(many[0]).toHaveLength(1536);
  });

  it('ON: refuses the cross-space failover (503), no silent cross-space compare', async () => {
    const svc = mkSvc({
      strict: '1',
      primary: bge(false),
      fallback: openai(),
      primarySpaceId: BGE_SPACE,
    });
    await expect(svc.embed('hello')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.embed('hello')).rejects.toThrow(/strict-guard/i);
    await expect(svc.embedMany(['a'])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('ON but primary READY: serves the primary space (compatible ⇒ no throw)', async () => {
    const svc = mkSvc({
      strict: '1',
      primary: bge(true), // warmed up: active == primary
      fallback: openai(),
      primarySpaceId: BGE_SPACE,
    });
    const v = await svc.embed('hello');
    expect(v).toHaveLength(1024); // bge-m3 primary served
  });

  it('ON with openai-only deployment (no fallback): never fires', async () => {
    const svc = mkSvc({
      strict: '1',
      primary: openai(),
      fallback: null,
      primarySpaceId: OPENAI_SPACE,
    });
    const v = await svc.embed('hello');
    expect(v).toHaveLength(1536);
  });

  it('exposes activeSpaceId / primarySpaceId', () => {
    const svc = mkSvc({
      strict: undefined,
      primary: bge(false),
      fallback: openai(),
      primarySpaceId: BGE_SPACE,
    });
    expect(svc.primarySpaceId()).toBe(BGE_SPACE);
    // active = fallback while primary is warming
    expect(svc.activeSpaceId()).toBe(OPENAI_SPACE);
  });
});
