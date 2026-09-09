import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled, envFlagNotDisabled } from '../common/env-validation';
import type { WarmupStatus } from '../common/warmup-status';

/**
 * Zero-shot intent classifier — multilingual NLI without enumerated
 * lexicons.
 *
 * Architecture:
 *   • Lazy-load a multilingual NLI model on module init (background;
 *     never blocks boot, never blocks the first request).
 *   • Until the model is ready, `classify` falls back to the
 *     punctuation-only heuristic (`?` → ask, else → tell).
 *   • Once ready, every miss runs through the NLI pipeline against the
 *     candidate labels ["question", "statement"]. The model assigns a
 *     probability to each; the higher wins and its probability becomes
 *     the confidence.
 *   • Results are LRU-cached on the trimmed message text — repeat
 *     queries are free.
 *
 * Runtime: a dedicated `worker_thread` owns the model (default), so ONNX
 * inference never blocks the main event loop — an in-thread pass froze
 * every other tenant's request for ~100-200ms per cache-missed message.
 * `CHAT_ROUTE_NLI_WORKER=0` keeps the original in-thread path for unit
 * tests and single-threaded benchmarks (same split as the cross-encoder
 * reranker, src/ai/cross-encoder/local-cross-encoder.provider.ts). Every
 * worker failure mode — spawn failure, warmup failure, RPC timeout,
 * crash — degrades to the punctuation fallback, i.e. exactly the
 * pre-warmup behavior, and waits out the retry backoff before re-warming.
 * The LRU cache stays on the main thread, so repeat queries never pay
 * the RPC hop.
 *
 * Model contract: a public HuggingFace repo with a transformers.js
 * zero-shot-classification ONNX export that covers English and Russian.
 * Default `Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7` (~340MB
 * quantized). The previous default (`Xenova/distilbert-base-multilingual-
 * cased-finetuned-mnli`) and the other Xenova XNLI exports now answer HTTP
 * 401 on the Hub, so a deployment that still names one of them never
 * warms. Override with CHAT_ROUTE_NLI_MODEL.
 *
 * Warmup failures back off (5m, doubling, capped at 1h) with a timer-driven
 * retry; a 401/403/404 from the Hub means the repo is gated or gone, so
 * that failure starts at the ceiling instead of climbing to it. The
 * bookkeeping is `warmupStatus()`, the same shape the embedder reports,
 * so the admin health grid shows the classifier degraded with the reason.
 *
 * No hardcoded phrase lists, no wh-pronoun catalogues, no
 * "interrogative cues" tables — every signal is derived from the
 * model's pretrained understanding of natural language.
 */

type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options: { hypothesis_template: string },
) => Promise<{
  sequence: string;
  labels: string[];
  scores: number[];
}>;

export interface IntentResult {
  intent: 'ask' | 'tell';
  confidence: number;
  source: 'nli' | 'punctuation' | 'cache';
}

const CACHE_SIZE = 2000;
const DEFAULT_MODEL = 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7';
const NLI_LABELS = ['question', 'statement'];
const HYPOTHESIS_TEMPLATE = 'This text is a {}.';
const WORKER_WARMUP_TIMEOUT_MS = 300_000;
const DEFAULT_CLASSIFY_TIMEOUT_MS = 3_000;
/** Latch after a classify RPC timeout before a replacement worker is warmed. */
const FAIL_RETRY_MS = 5 * 60_000;
/** First retry after a failed warmup; doubles per failure. */
const WARMUP_RETRY_BASE_MS = 5 * 60_000;
/** Ceiling on the warmup retry interval. */
const WARMUP_RETRY_MAX_MS = 60 * 60_000;
/**
 * transformers.js wording for the Hub statuses that mean the repo is gated
 * or gone (401/403/404). No retry fixes that model id, so the backoff
 * starts at its ceiling.
 */
const PERMANENT_LOAD_ERROR =
  /Unauthorized access to file|Forbidden access to file|Could not locate file|\b(?:401|403|404)\b/;

@Injectable()
export class IntentClassifierService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(IntentClassifierService.name);
  private readonly modelId: string;
  private readonly enabled: boolean;
  private readonly askThreshold: number;
  private readonly useWorker: boolean;
  private readonly classifyTimeoutMs: number;
  private classifier: ZeroShotPipeline | null = null;
  private readonly cache = new LRUCache<string, { intent: 'ask' | 'tell'; confidence: number }>(
    CACHE_SIZE,
  );

  // Worker runtime (mirrors LocalCrossEncoderProvider)
  private worker: Worker | null = null;
  private workerReady = false;
  private nextReqId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private warmupPromise: Promise<void> | null = null;
  private warmupTimer: NodeJS.Timeout | null = null;
  private warmupFailures = 0;
  private lastWarmupError: string | undefined;
  /** Earliest time the next warmup may start (backoff or classify-timeout latch). */
  private nextWarmupAt = 0;
  private stopped = false;

  constructor(private readonly config: ConfigService) {
    this.enabled = envFlagNotDisabled(this.config.get<string>('CHAT_ROUTE_NLI_ENABLED'));
    this.modelId = this.config.get<string>('CHAT_ROUTE_NLI_MODEL', DEFAULT_MODEL);
    this.askThreshold = parseFloat(this.config.get<string>('CHAT_ROUTE_NLI_ASK_THRESHOLD', '0.6'));
    this.useWorker = envFlagEnabled(this.config.get<string>('CHAT_ROUTE_NLI_WORKER', '1'));
    this.classifyTimeoutMs =
      parseInt(
        this.config.get<string>('CHAT_ROUTE_NLI_TIMEOUT_MS', String(DEFAULT_CLASSIFY_TIMEOUT_MS)),
        10,
      ) || DEFAULT_CLASSIFY_TIMEOUT_MS;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'NLI intent classifier disabled (CHAT_ROUTE_NLI_ENABLED=false) — punctuation-only intent',
      );
      return;
    }
    // Fire-and-forget warmup. The route handler never awaits this —
    // classify() falls back to punctuation while the model loads.
    void this.warmup();
  }

  /**
   * Terminate the inference worker thread. A worker_threads.Worker keeps
   * the event loop alive until terminated, so app teardown must call this
   * (same contract as LocalCrossEncoderProvider.terminate()). Idempotent.
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    const w = this.worker;
    this.worker = null;
    this.workerReady = false;
    if (w) {
      this.failAllPending(new Error('worker terminated on shutdown'));
      await w.terminate().catch(() => undefined);
    }
  }

  isReady(): boolean {
    return this.classifier !== null || this.workerReady;
  }

  stats(): {
    enabled: boolean;
    ready: boolean;
    model: string;
    askThreshold: number;
    cacheSize: number;
  } {
    return {
      enabled: this.enabled,
      ready: this.isReady(),
      model: this.modelId,
      askThreshold: this.askThreshold,
      cacheSize: this.cache.size,
    };
  }

  /** Warmup bookkeeping for the health surfaces (the embedder's shape). */
  warmupStatus(): WarmupStatus {
    const status: WarmupStatus = {
      ready: this.isReady(),
      failures: this.warmupFailures,
      inFlight: this.warmupPromise !== null,
    };
    if (this.lastWarmupError !== undefined) status.lastError = this.lastWarmupError;
    if (this.nextWarmupAt > Date.now())
      status.nextRetryAt = new Date(this.nextWarmupAt).toISOString();
    return status;
  }

  /** Test-only seam — injects a mock pipeline so unit tests can drive
   *  the NLI code path without loading the real model. A seam pipeline
   *  always runs in-thread (classify() prefers it over the worker). */
  setClassifierForTesting(pipeline: ZeroShotPipeline | null): void {
    this.classifier = pipeline;
    this.cache.clear();
  }

  async classify(message: string): Promise<IntentResult> {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      return { intent: 'tell', confidence: 0, source: 'punctuation' };
    }
    // Fast path: trailing `?` is universal and unambiguous — skip the
    // model entirely and save ~100-200ms inference latency.
    if (/\?\s*$/.test(message)) {
      return { intent: 'ask', confidence: 0.95, source: 'punctuation' };
    }
    if (!this.hasNliRuntime()) {
      // A crashed / timed-out worker re-warms in the background once the
      // backoff expires; this request keeps the punctuation fallback (a
      // request never blocks on a model load).
      if (this.useWorker && this.worker && this.enabled) void this.warmup();
      return { intent: 'tell', confidence: 0.7, source: 'punctuation' };
    }
    const cached = this.cache.get(trimmed);
    if (cached) {
      return { ...cached, source: 'cache' };
    }
    try {
      const result = this.classifier
        ? await this.classifier(trimmed, NLI_LABELS, {
            hypothesis_template: HYPOTHESIS_TEMPLATE,
          })
        : await this.rpc<{ labels: string[]; scores: number[] }>('classify', {
            text: trimmed,
            labels: NLI_LABELS,
            hypothesisTemplate: HYPOTHESIS_TEMPLATE,
          });
      const value = this.toIntent(result);
      this.cache.set(trimmed, value);
      return { ...value, source: 'nli' };
    } catch (e) {
      this.logger.warn(
        `NLI classify failed for "${trimmed.slice(0, 80)}": ${(e as Error).message}; falling back to punctuation`,
      );
      return { intent: 'tell', confidence: 0.7, source: 'punctuation' };
    }
  }

  /** Whether an NLI backend can serve this request right now: the
   *  in-thread pipeline (or test seam), or a warmed worker outside the
   *  failure latch. */
  private hasNliRuntime(): boolean {
    if (this.classifier !== null) return true;
    return this.workerReady && Date.now() >= this.nextWarmupAt;
  }

  private toIntent(result: { labels: string[]; scores: number[] }): {
    intent: 'ask' | 'tell';
    confidence: number;
  } {
    const qIdx = result.labels.indexOf('question');
    const qScore = qIdx >= 0 ? (result.scores[qIdx] ?? 0) : 0;
    if (qScore >= this.askThreshold) {
      return { intent: 'ask', confidence: qScore };
    }
    return { intent: 'tell', confidence: 1 - qScore };
  }

  /** Load (or await the in-flight load of) the model. Idempotent; a
   *  failed load schedules the next attempt after the backoff, so a
   *  request never re-downloads and a quiet host still retries. */
  private async warmup(): Promise<void> {
    if (this.isReady() || this.stopped) return;
    if (this.warmupPromise) return this.warmupPromise;
    if (Date.now() < this.nextWarmupAt) return;
    const attempt = this.warmupFailures + 1;
    const start = Date.now();
    this.warmupPromise = (this.useWorker ? this.warmupWorker() : this.warmupInThread())
      .then(() => {
        this.warmupFailures = 0;
        this.nextWarmupAt = 0;
        this.lastWarmupError = undefined;
        this.logger.log(
          `NLI classifier ready (${this.modelId}${this.useWorker ? ', worker' : ''}) — warmup ${Date.now() - start}ms, attempt ${attempt}`,
        );
      })
      .catch((e) => {
        const message = (e as Error).message;
        const permanent = PERMANENT_LOAD_ERROR.test(message);
        this.warmupFailures = attempt;
        this.lastWarmupError = permanent
          ? `model repo unavailable (gated or removed; set CHAT_ROUTE_NLI_MODEL to a public repo): ${message}`
          : message;
        const delay = permanent
          ? WARMUP_RETRY_MAX_MS
          : Math.min(WARMUP_RETRY_BASE_MS * 2 ** (attempt - 1), WARMUP_RETRY_MAX_MS);
        this.nextWarmupAt = Date.now() + delay;
        this.logger.warn(
          `NLI classifier warmup attempt ${attempt} failed for ${this.modelId}: ${this.lastWarmupError}; punctuation-only, retrying in ${Math.round(delay / 60000)}m`,
        );
        this.scheduleWarmupRetry(delay);
      })
      .finally(() => {
        this.warmupPromise = null;
      });
    return this.warmupPromise;
  }

  private scheduleWarmupRetry(delayMs: number): void {
    if (this.stopped) return;
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      void this.warmup();
    }, delayMs);
    // A pending retry must never keep the process (or a jest worker) alive.
    this.warmupTimer.unref?.();
  }

  private async warmupInThread(): Promise<void> {
    // Dynamic import so the transformers runtime is only paid for
    // when the feature is enabled — keeps cold-boot fast in
    // CHAT_ROUTE_NLI_ENABLED=false deployments.
    const t = (await import('@xenova/transformers')) as unknown as {
      env: { cacheDir?: string };
      pipeline: (task: string, modelId: string) => Promise<unknown>;
    };
    // transformers.js v2 ignores the python-style TRANSFORMERS_CACHE /
    // HF_HOME env vars — honour them explicitly so the operator's cache
    // mount actually works (same fix as cross-encoder.worker.ts).
    const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheDir) t.env.cacheDir = cacheDir;
    this.classifier = (await t.pipeline(
      'zero-shot-classification',
      this.modelId,
    )) as ZeroShotPipeline;
  }

  private async warmupWorker(): Promise<void> {
    // Re-warmup after a classify-RPC timeout must not orphan the previous
    // worker: an un-terminated worker_threads.Worker keeps its message
    // listener (and the ~340 MB loaded model) alive for the process
    // lifetime — one leaked worker per timeout incident. Tear the old
    // one down before spawning its replacement.
    const stale = this.worker;
    if (stale) {
      this.worker = null;
      this.failAllPending(new Error('worker replaced after stall'));
      await stale.terminate().catch(() => undefined);
    }
    const workerPath = this.resolveWorkerPath();
    this.worker = new Worker(workerPath);
    this.worker.on('message', (m: unknown) => this.handleReply(m));
    this.worker.on('error', (err) => {
      this.logger.warn(`intent-classifier worker error: ${err.message}`);
      this.failAllPending(err);
      this.workerReady = false;
    });
    this.worker.on('exit', (code) => {
      if (code !== 0) {
        this.logger.warn(`intent-classifier worker exited (${code})`);
      }
      this.failAllPending(new Error('worker exited'));
      this.workerReady = false;
    });
    await this.rpc<{ ready: boolean }>('warmup', { modelId: this.modelId });
    this.workerReady = true;
  }

  private resolveWorkerPath(): string {
    const distCandidate = join(__dirname, 'intent-classifier.worker.js');
    if (existsSync(distCandidate)) return distCandidate;
    return join(__dirname, 'intent-classifier.worker.ts');
  }

  private handleReply(msg: unknown): void {
    const m = msg as {
      id: number;
      ok: boolean;
      result?: unknown;
      error?: string;
    };
    const entry = this.pending.get(m.id);
    if (!entry) return;
    this.pending.delete(m.id);
    if (m.ok) entry.resolve(m.result);
    else entry.reject(new Error(m.error ?? 'unknown worker error'));
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  private rpc<R>(kind: 'warmup' | 'classify', payload: unknown): Promise<R> {
    if (!this.worker) {
      return Promise.reject(new Error('intent-classifier worker not initialised'));
    }
    const id = this.nextReqId++;
    // Warmup downloads/loads a ~340MB model; a classify call is a single
    // inference bounded by CHAT_ROUTE_NLI_TIMEOUT_MS so a wedged worker
    // can't pend forever.
    const timeoutMs = kind === 'warmup' ? WORKER_WARMUP_TIMEOUT_MS : this.classifyTimeoutMs;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.workerReady = false;
          // Latch like a warmup failure: without this, the next classify()
          // immediately re-warms (spawning a replacement worker) while
          // the wedged one may still be mid-inference — on a persistently
          // slow host that would cycle a new ~340 MB worker per timeout.
          // The latch gives the host FAIL_RETRY_MS to recover; intent
          // degrades to the punctuation heuristic meanwhile.
          if (kind === 'classify') {
            this.nextWarmupAt = Date.now() + FAIL_RETRY_MS;
          }
          reject(new Error(`intent-classifier '${kind}' RPC timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          (resolve as (value: unknown) => void)(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.worker!.postMessage({ id, kind, payload });
    });
  }
}
