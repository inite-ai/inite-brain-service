import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { LRUCache } from '../common/lru-cache';
import { withGenAiCall } from '../common/gen-ai-observability';
import { MetricsService } from '../metrics/metrics.service';
import type { EmbedderProvider } from './embedder/embedder-provider.interface';
import { OpenAIEmbedderProvider } from './embedder/openai-embedder.provider';
import { BgeM3EmbedderProvider } from './embedder/bge-m3-embedder.provider';

/**
 * EmbedderService — thin facade in front of an EmbedderProvider.
 *
 * Two providers shipped:
 *   - openai (default, back-compat): text-embedding-3-* via the
 *     OpenAI SDK. Identical-text → identical vector (deterministic).
 *   - bge-m3: Xenova/bge-m3 via @xenova/transformers, local inference.
 *     Multilingual cross-lingual recall; lazy warmup with graceful
 *     fallback to OpenAI on warmup failure.
 *
 * The cache lives here (not on the providers) so swapping providers
 * doesn't invalidate the existing LRU keys — the cache key includes
 * `provider.providerId` which already encodes model + dim, so OpenAI
 * and BGE-M3 entries cannot collide.
 */
@Injectable()
export class EmbedderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbedderService.name);
  private readonly cache: LRUCache<string, number[]>;
  private readonly primary: EmbedderProvider;
  private readonly fallback: EmbedderProvider | null;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const cacheSize = parseInt(
      this.configService.get<string>('EMBEDDING_CACHE_SIZE', '2000'),
      10,
    );
    this.cache = new LRUCache<string, number[]>(cacheSize);

    const providerName = this.configService.get<string>(
      'EMBEDDER_PROVIDER',
      'openai',
    );
    const openai = this.buildOpenAIProvider();
    if (providerName === 'bge-m3') {
      this.primary = this.buildBgeM3Provider();
      this.fallback = openai;
      this.logger.log(
        `Embedder primary=bge-m3 fallback=openai (until warmup completes)`,
      );
    } else {
      this.primary = openai;
      this.fallback = null;
      this.logger.log(`Embedder primary=openai`);
    }
  }

  async onModuleInit(): Promise<void> {
    // Fire-and-forget. The audit flagged this as P0: awaiting BGE-M3's
    // warmup here blocked NestFactory.create until the ~340 MB ONNX
    // pull + initial inference completed (10s warm cache, >60s cold).
    // Liveness then SIGKILL'd the container before /health could
    // answer, so a one-line `EMBEDDER_PROVIDER=bge-m3` flip bricked
    // the rollout. Now the primary stays "not ready" until warmup
    // resolves; `activeProvider()` routes to the OpenAI fallback in
    // the meantime, and `/ready` (HealthController) waits for the
    // primary to flip ready before reporting up.
    if (this.primary instanceof BgeM3EmbedderProvider) {
      void this.primary
        .warmup()
        .catch((e) =>
          this.logger.warn(
            `bge-m3 warmup failed, falling back to openai: ${(e as Error).message}`,
          ),
        );
    }
  }

  /**
   * Terminate the BGE-M3 worker thread on shutdown. A worker_threads
   * Worker keeps the event loop alive until terminated; without this the
   * process (and the e2e jest run) hangs on close.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.primary instanceof BgeM3EmbedderProvider) {
      await this.primary.terminate();
    }
  }

  /**
   * `/ready` probe. Up = the primary embedder is ready OR there's a
   * fallback the request path can use. We never report "not ready"
   * when an openai fallback is wired, because the service is in fact
   * able to serve search/synthesize traffic on the fallback.
   */
  isReady(): boolean {
    if (this.primary.isReady()) return true;
    if (this.fallback && this.fallback.isReady()) return true;
    return false;
  }

  /**
   * Embed a single string. Routes to the primary provider when it is
   * ready, otherwise to the fallback (back-compat with the OpenAI path).
   * Result is cached by (providerId, text); cache survives provider
   * swaps but cannot serve cross-provider hits because the key carries
   * the providerId.
   */
  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) return new Array(this.getDimensions()).fill(0);

    const provider = this.activeProvider();
    const key = this.cacheKey(provider.providerId, trimmed);
    const hit = this.cache.get(key);
    if (hit) return hit;
    // Provider IDs encode `${vendor}:${model}:${dim}` (see
    // OpenAIEmbedderProvider / BgeM3EmbedderProvider). We split for
    // gen_ai.system + gen_ai.request.model; OpenAI is the only vendor
    // whose API returns usage{total_tokens}, so the metric's token
    // counter populates only on that branch (BGE is local — no API
    // tokens to count). Cache hits skip the wrapper entirely so the
    // metric reflects real API calls, not memoised reads.
    const [vendor, model] = provider.providerId.split(':');
    const isOpenAI = vendor === 'openai';
    // Return `{ vector, usage }` from the wrapped fn so withGenAiCall can
    // read `.usage` and populate the embedding token counter. A bare
    // vector has no usage, which is why the metric used to read 0.
    const { vector } = await withGenAiCall<{
      vector: number[];
      usage?: { total_tokens?: number };
    }>(
      {
        kind: 'embed',
        spanName: 'gen_ai.embed',
        system: isOpenAI ? 'openai' : 'huggingface',
        model: model ?? '_',
      },
      this.metrics,
      async () =>
        provider.embedWithUsage
          ? provider.embedWithUsage(trimmed)
          : { vector: await provider.embed(trimmed) },
    );
    this.cache.set(key, vector);
    return vector;
  }

  getDimensions(): number {
    return this.activeProvider().getDimensions();
  }

  /**
   * Batched embed. Used by ingest / predicate-registry bootstrap /
   * dreams dedup / reindex — anywhere we'd otherwise N×embed() in a
   * loop. Caches per-text the same way as embed(); the underlying
   * provider's `embedMany` is invoked only for the cache-missed
   * subset, then the results are stitched back together in original
   * order.
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const provider = this.activeProvider();
    const out: number[][] = new Array(texts.length);
    const missIdx: number[] = [];
    const missTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const trimmed = texts[i]?.trim() ?? '';
      if (!trimmed) {
        out[i] = new Array(this.getDimensions()).fill(0);
        continue;
      }
      const k = this.cacheKey(provider.providerId, trimmed);
      const hit = this.cache.get(k);
      if (hit) {
        out[i] = hit;
      } else {
        missIdx.push(i);
        missTexts.push(trimmed);
      }
    }
    if (missTexts.length > 0) {
      // Use the provider's batched endpoint when available; fall back
      // to per-text embed() otherwise. The fallback keeps the API
      // safe for providers that haven't implemented embedMany yet
      // (e.g. third-party plugins).
      const vecs = provider.embedMany
        ? await provider.embedMany(missTexts)
        : await Promise.all(missTexts.map((t) => provider.embed(t)));
      // A provider that returns fewer vectors than inputs (or a hole) would
      // otherwise cache `undefined` and write it as the row's embedding,
      // silently corrupting the vector store. Fail loud instead.
      if (vecs.length !== missTexts.length) {
        throw new Error(
          `embedMany(${provider.providerId}) returned ${vecs.length} vectors ` +
            `for ${missTexts.length} inputs`,
        );
      }
      for (let j = 0; j < missTexts.length; j++) {
        const text = missTexts[j];
        const vec = vecs[j];
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error(
            `embedMany(${provider.providerId}) produced an empty/invalid ` +
              `vector at index ${j}`,
          );
        }
        const k = this.cacheKey(provider.providerId, text);
        this.cache.set(k, vec);
        out[missIdx[j]] = vec;
      }
    }
    return out;
  }

  /**
   * Test/diagnostic surface — no business code should depend on cache
   * shape. The `inFlight` + `waiting` fields are kept at 0 for back-
   * compat with admin /v1/admin/router-stats consumers; concurrency
   * accounting now lives on the per-provider Semaphore and is not
   * surfaced here.
   */
  /**
   * Drop every cached (providerId, text) → vector entry. Used by the
   * GDPR forget path: the cache is keyed on raw text, so a forgotten
   * subject's identifying text would otherwise linger as a cache key in
   * process memory. Returns the number of entries evicted. Best-effort,
   * process-local — forget is rare enough that the cold-cache cost is
   * acceptable.
   */
  evictAll(): number {
    const n = this.cache.size;
    this.cache.clear();
    return n;
  }

  cacheStats(): {
    size: number;
    inFlight: number;
    waiting: number;
    provider: string;
  } {
    return {
      size: this.cache.size,
      inFlight: 0,
      waiting: 0,
      provider: this.activeProvider().providerId,
    };
  }

  private activeProvider(): EmbedderProvider {
    if (this.primary.isReady()) return this.primary;
    if (this.fallback) return this.fallback;
    return this.primary;
  }

  private buildOpenAIProvider(): OpenAIEmbedderProvider {
    return new OpenAIEmbedderProvider({
      apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY'),
      model: this.configService.get<string>(
        'OPENAI_EMBEDDING_MODEL',
        'text-embedding-3-small',
      ),
      dimensions: parseInt(
        this.configService.get<string>('OPENAI_EMBEDDING_DIMENSIONS', '1536'),
        10,
      ),
      timeoutMs: parseInt(
        this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
        10,
      ),
      maxRetries: parseInt(
        this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
        10,
      ),
      concurrency: parseInt(
        this.configService.get<string>('OPENAI_CONCURRENCY', '8'),
        10,
      ),
    });
  }

  private buildBgeM3Provider(): BgeM3EmbedderProvider {
    return new BgeM3EmbedderProvider({
      modelId: this.configService.get<string>(
        'BGE_M3_MODEL_ID',
        'Xenova/bge-m3',
      ),
      dimensions: parseInt(
        this.configService.get<string>('BGE_M3_DIMENSIONS', '1024'),
        10,
      ),
      concurrency: parseInt(
        this.configService.get<string>('BGE_M3_CONCURRENCY', '4'),
        10,
      ),
      // Off-by-default for now (1) tests assume in-thread; (2) the
      // worker bootstraps @xenova/transformers fresh per worker which
      // doubles peak memory during warmup. Operators flip
      // BGE_M3_WORKER=1 to run inference off the main event loop.
      useWorker: this.configService.get<string>('BGE_M3_WORKER', '0') === '1',
    });
  }

  private cacheKey(providerId: string, text: string): string {
    return createHash('sha256')
      .update(`${providerId}:${text}`)
      .digest('hex');
  }
}
