/**
 * Embedder write guard + honest readiness.
 *
 * Background — the defect this locks down. With `EMBEDDER_PROVIDER=bge-m3`
 * (what production deploys) the ONNX model takes ~10-20s to load. During
 * that window `activeProvider()` failed over to the 1536-wide OpenAI
 * fallback while the corpus is 1024-wide. Verified against SurrealDB 3.2.4:
 * the vector columns are `option<array<float>>` with NO width, so the wrong
 * width is accepted silently and durably; afterwards
 * `vector::similarity::cosine` errors for EVERY row of that table, the
 * `<|K,DIST|>` operator silently skips the mismatched rows, and
 * `DEFINE INDEX … HNSW DIMENSION 1024` refuses to build.
 *
 * Proves:
 *   - `/ready` (isReady) reflects the PRIMARY only, so the rollout
 *     playbook's "reindex after /ready is 200" gate is real.
 *   - Vector WRITES fail closed during the window, unconditionally.
 *   - Vector READS keep the documented degraded-mode failover.
 *   - HNSW DDL reads the primary width, never the fallback's.
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

/** A primary that claims to be ready and in-space but emits the WRONG
 *  width — stands in for warmup regressing mid-call (worker death). */
const liar = (): FakeProvider => ({
  providerId: 'bge-m3:Xenova/bge-m3:1024',
  getDimensions: () => 1024,
  isReady: () => true,
  embed: async () => new Array(1536).fill(0.3),
  embedMany: async (t) => t.map(() => new Array(1536).fill(0.3)),
});

const BGE_SPACE = 'bge-m3:Xenova/bge-m3:1024:l2';
const OPENAI_SPACE = 'openai:text-embedding-3-small:1536:l2';

interface Counted {
  inc: jest.Mock;
}

function mkSvc(opts: {
  primary: FakeProvider;
  fallback: FakeProvider | null;
  primarySpaceId: string;
}): { svc: EmbedderService; fallbackCounter: Counted } {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      if (k === 'OPENAI_EMBEDDING_DIMENSIONS') return '1536';
      if (k === 'EMBEDDING_CACHE_SIZE') return '50';
      if (k === 'EMBEDDER_PROVIDER') return 'openai';
      return def;
    },
    getOrThrow: () => 'sk-test-stub',
  } as never;
  const fallbackCounter: Counted = { inc: jest.fn() };
  // `recordOpenAiCall` is what withGenAiCall reaches for on the embed path.
  const metrics = {
    embedderFallbackServes: fallbackCounter,
    recordOpenAiCall: jest.fn(),
  } as never;
  const svc = new EmbedderService(config, metrics);
  (svc as unknown as { primary: FakeProvider }).primary = opts.primary;
  (svc as unknown as { fallback: FakeProvider | null }).fallback = opts.fallback;
  (svc as unknown as { primarySpaceIdValue: string }).primarySpaceIdValue = opts.primarySpaceId;
  return { svc, fallbackCounter };
}

describe('EmbedderService — readiness reflects the primary', () => {
  it('is NOT ready while the primary warms, even with a fallback wired', () => {
    // The regression that made the rollout playbook unsafe: isReady() ORed
    // the fallback in, and OpenAIEmbedderProvider.isReady() is always true,
    // so /ready was green from boot and the operator's "wait for warm"
    // gate never held.
    const { svc } = mkSvc({ primary: bge(false), fallback: openai(), primarySpaceId: BGE_SPACE });
    expect(svc.isReady()).toBe(false);
    expect(svc.isServingDegraded()).toBe(true);
  });

  it('is ready once the primary warms', () => {
    const { svc } = mkSvc({ primary: bge(true), fallback: openai(), primarySpaceId: BGE_SPACE });
    expect(svc.isReady()).toBe(true);
    expect(svc.isServingDegraded()).toBe(false);
  });

  it('openai-only deployment is ready immediately (no behaviour change)', () => {
    const { svc } = mkSvc({ primary: openai(), fallback: null, primarySpaceId: OPENAI_SPACE });
    expect(svc.isReady()).toBe(true);
    expect(svc.isServingDegraded()).toBe(false);
  });
});

describe('EmbedderService — vector writes fail closed across spaces', () => {
  it('embedForWrite refuses during the warmup window', async () => {
    const { svc } = mkSvc({ primary: bge(false), fallback: openai(), primarySpaceId: BGE_SPACE });
    await expect(svc.embedForWrite('hello')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.embedForWrite('hello')).rejects.toThrow(/write guard/i);
  });

  it('embedManyForWrite refuses during the warmup window', async () => {
    const { svc } = mkSvc({ primary: bge(false), fallback: openai(), primarySpaceId: BGE_SPACE });
    await expect(svc.embedManyForWrite(['a', 'b'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('is unconditional — no flag has to be set for the guard to hold', async () => {
    // EMBEDDING_SPACE_STRICT is absent from .env.example AND from
    // deploy-brain.yml (excluded by agreement), so a flag-gated guard is
    // dead code in production. This one is not gated.
    const { svc } = mkSvc({ primary: bge(false), fallback: openai(), primarySpaceId: BGE_SPACE });
    expect(process.env.EMBEDDING_SPACE_STRICT).toBeUndefined();
    await expect(svc.embedForWrite('x')).rejects.toThrow(/write guard/i);
  });

  it('permits writes once the primary is warm', async () => {
    const { svc } = mkSvc({ primary: bge(true), fallback: openai(), primarySpaceId: BGE_SPACE });
    await expect(svc.embedForWrite('hello')).resolves.toHaveLength(1024);
    const many = await svc.embedManyForWrite(['a', 'b']);
    expect(many).toHaveLength(2);
    expect(many[0]).toHaveLength(1024);
  });

  it('permits writes on an openai-only deployment', async () => {
    const { svc } = mkSvc({ primary: openai(), fallback: null, primarySpaceId: OPENAI_SPACE });
    await expect(svc.embedForWrite('hello')).resolves.toHaveLength(1536);
  });

  it('catches a wrong width even when the space pre-check passes', async () => {
    // Post-check: warmup can regress between the pre-check and the
    // inference. Width is the invariant that actually matters.
    const { svc } = mkSvc({ primary: liar(), fallback: openai(), primarySpaceId: BGE_SPACE });
    await expect(svc.embedForWrite('hello')).rejects.toThrow(/1536-wide vector but/i);
    await expect(svc.embedManyForWrite(['a'])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('EmbedderService — reads keep the documented degraded mode', () => {
  it('embed() still serves the fallback during warmup', async () => {
    // deploy-brain.yml promises search/synthesize keep serving on the
    // OpenAI fallback during the ONNX load. Reads are transient and
    // self-healing, so that behaviour is preserved deliberately.
    const { svc } = mkSvc({ primary: bge(false), fallback: openai(), primarySpaceId: BGE_SPACE });
    await expect(svc.embed('hello')).resolves.toHaveLength(1536);
  });

  it('counts every fallback serve so the window is not silent', async () => {
    const { svc, fallbackCounter } = mkSvc({
      primary: bge(false),
      fallback: openai(),
      primarySpaceId: BGE_SPACE,
    });
    await svc.embed('hello');
    expect(fallbackCounter.inc).toHaveBeenCalledWith({ primary: BGE_SPACE });
  });
});

describe('EmbedderService — width reported for durable DDL', () => {
  it('primaryDimensions ignores the fallback that is currently serving', () => {
    // HNSW DIMENSION is baked into DDL. Reading the ACTIVE provider here
    // would build a 1536 index for a 1024 corpus.
    const { svc } = mkSvc({ primary: bge(false), fallback: openai(), primarySpaceId: BGE_SPACE });
    expect(svc.getDimensions()).toBe(1536); // active == fallback, unchanged
    expect(svc.primaryDimensions()).toBe(1024); // configured == what rows will be
  });
});
