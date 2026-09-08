import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { LRUCache } from '../common/lru-cache';
import { withGenAiCall } from '../common/gen-ai-observability';
import { MetricsService } from '../metrics/metrics.service';
import type { EmbedderProvider } from './embedder/embedder-provider.interface';
import { createOpenAiClientOrThrow } from './openai-client';
import { OpenAIEmbedderProvider } from './embedder/openai-embedder.provider';
import { BgeM3EmbedderProvider } from './embedder/bge-m3-embedder.provider';
import { envFlagEnabled } from '../common/env-validation';
import {
  DEFAULT_EMBEDDER_PROVIDER,
  declaredSpace,
  describeSpaceIncompatibility,
  embeddingSpaceIdFromProviderId,
  isEmbedderProviderName,
  spacesCompatible,
  type EmbedderProviderName,
  type EmbeddingNorm,
} from './embedder/embedding-space';

/** Minimum gap between two "serving on fallback" warnings. */
const FALLBACK_WARN_THROTTLE_MS = 10_000;

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
  private lastFallbackWarnAt = 0;
  private readonly cache: LRUCache<string, number[]>;
  private readonly primary: EmbedderProvider;
  private readonly fallback: EmbedderProvider | null;
  /**
   * The canonical space id of the PRIMARY (configured) provider — the space
   * a tenant's rows are expected to be in once reindexed. Computed once at
   * boot from the provider's model+dim+norm; the strict-space guard compares
   * the serving provider's space against this. Not a boolean flag, so it is
   * safe to capture in the constructor.
   */
  private readonly primarySpaceIdValue: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const cacheSize = parseInt(this.configService.get<string>('EMBEDDING_CACHE_SIZE', '2000'), 10);
    this.cache = new LRUCache<string, number[]>(cacheSize);

    const configured = this.configService.get<string>(
      'EMBEDDER_PROVIDER',
      DEFAULT_EMBEDDER_PROVIDER,
    );
    const providerName: EmbedderProviderName = isEmbedderProviderName(configured)
      ? configured
      : DEFAULT_EMBEDDER_PROVIDER;
    const openai = this.buildOpenAIProvider();
    if (providerName === 'bge-m3') {
      this.primary = this.buildBgeM3Provider();
      this.fallback = openai;
      this.logger.log(`Embedder primary=bge-m3 fallback=openai (until warmup completes)`);
    } else {
      this.primary = openai;
      this.fallback = null;
      this.logger.log(`Embedder primary=openai`);
    }
    this.primarySpaceIdValue = this.spaceIdOf(this.primary);
  }

  async onModuleInit(): Promise<void> {
    // Fire-and-forget. The audit flagged this as P0: awaiting BGE-M3's
    // warmup here blocked NestFactory.create until the ~340 MB ONNX
    // pull + initial inference completed (10s warm cache, >60s cold).
    // Liveness then SIGKILL'd the container before /health could
    // answer, so a one-line `EMBEDDER_PROVIDER=bge-m3` flip bricked
    // the rollout. Now the primary stays "not ready" until warmup
    // resolves; `servingProvider()` routes to the OpenAI fallback in
    // the meantime, and `/ready` (HealthController) waits for the
    // primary to flip ready before reporting up.
    if (this.primary instanceof BgeM3EmbedderProvider) {
      void this.primary
        .warmup()
        .catch((e) =>
          this.logger.warn(`bge-m3 warmup failed, falling back to openai: ${(e as Error).message}`),
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
   * `/ready` probe. Up = the next embed would answer in the CONFIGURED
   * space. Defined as exactly that question, so "ready" cannot mean
   * anything other than "answers are in the space the corpus is in".
   *
   * The old form ORed the fallback in — "is somebody able to answer" —
   * and OpenAIEmbedderProvider.isReady() is unconditionally true, so
   * `/ready` was green from the first millisecond of boot whenever
   * `EMBEDDER_PROVIDER=bge-m3`. That broke
   * the one gate the rollout playbook depends on: deploy-brain.yml tells
   * the operator to run the embedding reindex "after /ready returns 200
   * (model warm)". With /ready green during warmup, the sweep runs on the
   * OpenAI fallback and rewrites every vector in every table at 1536 wide
   * for a tenant whose space is bge-m3/1024 — mass, durable poisoning.
   *
   * Nothing external gates on this route (Traefik routes only /v1, /mcp,
   * /health, /registry; the container healthcheck probes /health; the
   * deploy's readiness loop is `continue-on-error`), so reporting the
   * truth here takes no traffic out of rotation — it only makes the
   * operator's documented gate real. Liveness stays on /health, which is
   * unchanged and still answers during warmup.
   */
  isReady(): boolean {
    return this.servesPrimarySpace();
  }

  /**
   * True when the request path would answer from a space OTHER than the
   * configured one — the warmup window, or a failed warmup. Surfaced to
   * the admin health grid so the degraded state is legible instead of
   * rendering a green `ok` row.
   */
  isServingDegraded(): boolean {
    return !this.servesPrimarySpace();
  }

  /**
   * THE predicate. Readiness, the degraded flag and the write guard are
   * all this one expression, so they cannot disagree with each other or
   * with what `embed()` actually does.
   *
   * Stated as a property rather than a checklist: `/ready` is green iff
   * the provider that would serve the very next call is in the configured
   * space. There is no way to be "ready" while answering from a different
   * space, because that is the same question. The old form asked a
   * different one — "is SOMEBODY able to answer" — which is why `/ready`
   * was green from boot while every answer came from the wrong space.
   */
  private servesPrimarySpace(): boolean {
    return spacesCompatible(this.spaceIdOf(this.servingProvider()), this.primarySpaceIdValue);
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

    const provider = this.serveProvider();
    const key = this.cacheKey(provider.providerId, trimmed);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const vector = await this.embedThrough(provider, trimmed);
    this.cache.set(key, vector);
    return vector;
  }

  /**
   * Embed WITHOUT reading or writing the cache.
   *
   * For the capability probe (src/metrics/capability-probe.service.ts),
   * which measures the width of a vector the embedder actually produced.
   * Through `embed()` a fixed probe string would be a cache hit from the
   * second tick onwards, and the probe would then be measuring the LRU —
   * a green signal that proves nothing, which is the exact class of bug
   * it exists to catch. Nothing on the request path should use this: the
   * cache is there for a reason.
   */
  async embedUncached(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) return new Array(this.getDimensions()).fill(0);
    return this.embedThrough(this.serveProvider(), trimmed);
  }

  /** The provider call itself, with its gen_ai span + token accounting. */
  private async embedThrough(provider: EmbedderProvider, trimmed: string): Promise<number[]> {
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
    return vector;
  }

  getDimensions(): number {
    return this.servingProvider().getDimensions();
  }

  /**
   * Width of the PRIMARY (configured) provider — the width a tenant's rows
   * are expected to be, independent of who happens to be serving right now.
   *
   * `getDimensions()` reads the ACTIVE provider, so during the bge-m3
   * warmup window it answers 1536 (the OpenAI fallback) for a deployment
   * whose corpus is 1024. Any consumer baking a width into durable state —
   * HNSW `DIMENSION` DDL above all — must use this instead, or it builds
   * an index the primary can never write to.
   */
  primaryDimensions(): number {
    return this.primary.getDimensions();
  }

  /**
   * Embed text that is about to be PERSISTED. Fails closed when the
   * serving provider's space is incompatible with the configured primary.
   *
   * Read and write are asymmetric on purpose. A cross-space READ is
   * transient and self-healing: it returns a bad ranking (or a 503) for the
   * seconds the primary is warming, and is correct again afterwards. A
   * cross-space WRITE is durable damage — the vector columns are
   * `option<array<float>>` with no width, so SurrealDB accepts a 1536-wide
   * vector into a 1024-wide corpus silently and forever. Afterwards
   * `vector::similarity::cosine` raises "The two vectors must be of the
   * same dimension" for EVERY row of that table (one poisoned row breaks
   * the whole query), the `<|K,DIST|>` operator quietly skips the
   * mismatched rows, and `DEFINE INDEX … HNSW DIMENSION 1024` refuses to
   * build at all. All three verified against SurrealDB 3.2.4.
   *
   * So there is no configuration in which persisting a fallback-width
   * vector is the desired outcome, and this guard is unconditional rather
   * than flag-gated: failing an ingest with a 503 the caller can retry is
   * strictly better than accepting a write that poisons the tenant.
   */
  async embedForWrite(text: string): Promise<number[]> {
    this.assertWriteSpaceSafe();
    const vector = await this.embed(text);
    this.assertWriteWidth(vector.length);
    return vector;
  }

  /** Batched {@link embedForWrite}. The reindex sweep and every composer
   *  batch go through here. */
  async embedManyForWrite(texts: string[]): Promise<number[][]> {
    this.assertWriteSpaceSafe();
    const vectors = await this.embedMany(texts);
    for (const v of vectors) this.assertWriteWidth(v.length);
    return vectors;
  }

  /**
   * Refuse when the provider that would serve is not in the primary's
   * space. Checked BEFORE the embed so a doomed batch costs no inference.
   */
  private assertWriteSpaceSafe(): void {
    if (this.servesPrimarySpace()) return;
    const servingSpace = this.spaceIdOf(this.servingProvider());
    const reason = describeSpaceIncompatibility(servingSpace, this.primarySpaceIdValue);
    throw new ServiceUnavailableException(
      `embedding write guard: refusing to persist a vector produced in ` +
        `'${servingSpace}' into a corpus in '${this.primarySpaceIdValue}' (${reason}). ` +
        `The primary embedder is still warming up; retry once it is ready.`,
    );
  }

  /**
   * Post-check on the produced width. The pre-check can race: warmup may
   * fail (or a worker may die) between the check and the inference, which
   * would flip the serving provider mid-call. Width is the invariant that
   * actually matters, so assert it on the result too.
   */
  private assertWriteWidth(width: number): void {
    const expected = this.primary.getDimensions();
    if (width === expected) return;
    throw new ServiceUnavailableException(
      `embedding write guard: produced a ${width}-wide vector but the ` +
        `configured embedder is ${expected}-wide (${this.primarySpaceIdValue}). ` +
        `Refusing to persist a mismatched vector.`,
    );
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
    const provider = this.serveProvider();
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
      for (const [j, text] of missTexts.entries()) {
        const vec = vecs[j];
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error(
            `embedMany(${provider.providerId}) produced an empty/invalid ` + `vector at index ${j}`,
          );
        }
        const k = this.cacheKey(provider.providerId, text);
        this.cache.set(k, vec);
        const outIdx = missIdx[j]; // parallel to missTexts
        if (outIdx !== undefined) out[outIdx] = vec;
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
      provider: this.servingProvider().providerId,
    };
  }

  /**
   * The provider that would answer the next call. PURE — no metrics, no
   * logging — because `servesPrimarySpace()` (and therefore `/ready` and
   * every health probe) calls it. Observability of an actual fallback
   * serve belongs on the embed path, not on the selector.
   */
  private servingProvider(): EmbedderProvider {
    if (this.primary.isReady()) return this.primary;
    if (this.fallback) return this.fallback;
    return this.primary;
  }

  /**
   * Record that the fallback served instead of the primary. Previously
   * this substitution left no trace at all: the only fallback-related
   * logging fires on warmup FAILURE, so the ordinary warmup window — when
   * every request is silently answered in the wrong embedding space — was
   * invisible in both logs and metrics. (`embedMany`, which the reindex
   * sweep uses, does not even emit a gen_ai span.)
   *
   * A counter carries the signal; the log line is throttled to once per
   * 10s so a busy warmup window cannot flood the log.
   */
  private noteFallbackServe(): void {
    this.metrics?.embedderFallbackServes.inc({ primary: this.primarySpaceIdValue });
    const now = Date.now();
    if (now - this.lastFallbackWarnAt < FALLBACK_WARN_THROTTLE_MS) return;
    this.lastFallbackWarnAt = now;
    this.logger.warn(
      `embedder serving on FALLBACK: primary '${this.primarySpaceIdValue}' is not ready; ` +
        `answering in '${this.spaceIdOf(this.fallback!)}'. Vector writes are refused ` +
        `until the primary warms up; reads are cross-space and unreliable.`,
    );
  }

  /**
   * The canonical space id of the provider that would serve RIGHT NOW.
   * Used by the reindex sweep to stamp `embeddingSpaceId` on rewritten
   * rows (behind EMBEDDING_SPACE_TRACKING) so a row declares the space it
   * was embedded in.
   */
  activeSpaceId(): string {
    return this.spaceIdOf(this.servingProvider());
  }

  /**
   * The space id of the PRIMARY (configured) provider — the space a
   * tenant's rows are expected to be in once reindex completes. Stable for
   * the life of the process (embedder config is boot-time).
   */
  primarySpaceId(): string {
    return this.primarySpaceIdValue;
  }

  /**
   * The serving provider for an actual embed call. Byte-identical to
   * `servingProvider()` UNLESS EMBEDDING_SPACE_STRICT is on: then a query
   * that would be embedded in a space INCOMPATIBLE with the primary
   * (configured) space — the warmup-window failover from bge-m3 (1024) to
   * the OpenAI fallback (1536) is the canonical case — is refused rather
   * than silently cross-space-compared against the target rows. Read the
   * flag per-call so an operator flip takes effect without a restart.
   */
  private serveProvider(): EmbedderProvider {
    const provider = this.servingProvider();
    // Observability lives here, on the embed path, so the pure selector
    // stays callable from health probes without inflating the counter.
    if (provider !== this.primary) this.noteFallbackServe();
    if (!envFlagEnabled(this.configService.get<string>('EMBEDDING_SPACE_STRICT'))) {
      return provider; // default: the existing warmup failover, unchanged
    }
    const servingSpace = this.spaceIdOf(provider);
    if (!spacesCompatible(servingSpace, this.primarySpaceIdValue)) {
      const reason = describeSpaceIncompatibility(servingSpace, this.primarySpaceIdValue);
      // 503, not 500: this is transient — the primary provider is warming
      // up (or has failed warmup); the query is refused ONLY because a
      // cross-space compare would be meaningless, not because of a bug.
      throw new ServiceUnavailableException(
        `embedding space strict-guard: refusing to serve a query in '${servingSpace}' ` +
          `against rows in '${this.primarySpaceIdValue}' (${reason}). The primary ` +
          `embedder is not ready; retry once warmup completes or reindex the tenant ` +
          `into the serving space.`,
      );
    }
    return provider;
  }

  /**
   * The canonical embedding-space id of a provider: its providerId
   * (`vendor:model:dim`) plus normalization. A provider whose id is not the
   * expected three-part shape (e.g. a test stub) falls back to its raw
   * providerId, which is only ever compatible with a byte-identical id — so
   * the guard never guesses a cross-space compare is safe.
   */
  private spaceIdOf(provider: EmbedderProvider): string {
    return (
      embeddingSpaceIdFromProviderId(provider.providerId, this.normOf(provider)) ??
      provider.providerId
    );
  }

  /**
   * Output normalization of a provider. Both shipped providers emit unit
   * vectors (OpenAI by API contract; bge-m3 via `normalize:true`), so `l2`
   * is the house default. A genuinely non-normalized provider must be a
   * DISTINCT space, so it would override this before shipping.
   */
  private normOf(_provider: EmbedderProvider): EmbeddingNorm {
    return 'l2';
  }

  // Model identity and width come from the declaration, never from env.
  // The four knobs that used to set them are deliberately gone: a width
  // is a property of the model, so an operator "configuring" one could
  // only desynchronise the store from what the model emits. Concurrency
  // and the worker toggle stay — they are genuinely deployment-shaped and
  // cannot make a vector the wrong width.
  private buildOpenAIProvider(): OpenAIEmbedderProvider {
    return new OpenAIEmbedderProvider({
      client: createOpenAiClientOrThrow(this.configService),
      space: declaredSpace('openai'),
      concurrency: parseInt(this.configService.get<string>('OPENAI_CONCURRENCY', '8'), 10),
    });
  }

  private buildBgeM3Provider(): BgeM3EmbedderProvider {
    return new BgeM3EmbedderProvider({
      space: declaredSpace('bge-m3'),
      concurrency: parseInt(this.configService.get<string>('BGE_M3_CONCURRENCY', '4'), 10),
      // Off-by-default for now (1) tests assume in-thread; (2) the
      // worker bootstraps @xenova/transformers fresh per worker which
      // doubles peak memory during warmup. Operators flip
      // BGE_M3_WORKER=1 to run inference off the main event loop.
      useWorker: envFlagEnabled(this.configService.get<string>('BGE_M3_WORKER')),
    });
  }

  private cacheKey(providerId: string, text: string): string {
    return createHash('sha256').update(`${providerId}:${text}`).digest('hex');
  }
}
