import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled, envFlagNotDisabled } from '../common/env-validation';

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
 * pre-warmup behavior, and latches for FAIL_RETRY_MS before re-warming.
 * The LRU cache stays on the main thread, so repeat queries never pay
 * the RPC hop.
 *
 * Model choice: `Xenova/distilbert-base-multilingual-cased-finetuned-mnli`
 * (~135MB ONNX). XNLI-finetuned distilbert, 100+ languages including
 * English + Russian. Trade-off vs `Xenova/mDeBERTa-v3-base-mnli-xnli`
 * (~330MB, better quality): the distilled model gives sub-200ms
 * inference on Node CPU, which keeps the LLM-skip path latency budget
 * intact. Override with CHAT_ROUTE_NLI_MODEL when better accuracy is
 * worth the latency.
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
const DEFAULT_MODEL =
  'Xenova/distilbert-base-multilingual-cased-finetuned-mnli';
const NLI_LABELS = ['question', 'statement'];
const HYPOTHESIS_TEMPLATE = 'This text is a {}.';
const WORKER_WARMUP_TIMEOUT_MS = 120_000;
const DEFAULT_CLASSIFY_TIMEOUT_MS = 3_000;
const FAIL_RETRY_MS = 5 * 60_000;

@Injectable()
export class IntentClassifierService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(IntentClassifierService.name);
  private readonly modelId: string;
  private readonly enabled: boolean;
  private readonly askThreshold: number;
  private readonly useWorker: boolean;
  private readonly classifyTimeoutMs: number;
  private classifier: ZeroShotPipeline | null = null;
  private readonly cache = new LRUCache<
    string,
    { intent: 'ask' | 'tell'; confidence: number }
  >(CACHE_SIZE);

  // Worker runtime (mirrors LocalCrossEncoderProvider)
  private worker: Worker | null = null;
  private workerReady = false;
  private nextReqId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private warmupPromise: Promise<void> | null = null;
  private failedUntil = 0;

  constructor(private readonly config: ConfigService) {
    this.enabled =
      envFlagNotDisabled(this.config.get<string>('CHAT_ROUTE_NLI_ENABLED'));
    this.modelId = this.config.get<string>(
      'CHAT_ROUTE_NLI_MODEL',
      DEFAULT_MODEL,
    );
    this.askThreshold = parseFloat(
      this.config.get<string>('CHAT_ROUTE_NLI_ASK_THRESHOLD', '0.6'),
    );
    this.useWorker = envFlagEnabled(
      this.config.get<string>('CHAT_ROUTE_NLI_WORKER', '1'),
    );
    this.classifyTimeoutMs =
      parseInt(
        this.config.get<string>(
          'CHAT_ROUTE_NLI_TIMEOUT_MS',
          String(DEFAULT_CLASSIFY_TIMEOUT_MS),
        ),
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
      // failure latch expires; this request keeps the punctuation
      // fallback (a request never blocks on a model load).
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
    return this.workerReady && Date.now() >= this.failedUntil;
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
   *  failed load latches for FAIL_RETRY_MS so we don't re-download on
   *  every request. */
  private async warmup(): Promise<void> {
    if (this.isReady()) return;
    if (this.warmupPromise) return this.warmupPromise;
    if (Date.now() < this.failedUntil) return;
    const start = Date.now();
    this.warmupPromise = (this.useWorker
      ? this.warmupWorker()
      : this.warmupInThread()
    )
      .then(() => {
        this.logger.log(
          `NLI classifier ready (${this.modelId}${this.useWorker ? ', worker' : ''}) — warmup ${Date.now() - start}ms`,
        );
      })
      .catch((e) => {
        this.failedUntil = Date.now() + FAIL_RETRY_MS;
        this.logger.warn(
          `NLI classifier warmup failed for ${this.modelId}: ${(e as Error).message}; punctuation-only, retrying after ${Math.round(FAIL_RETRY_MS / 60000)}m`,
        );
      })
      .finally(() => {
        this.warmupPromise = null;
      });
    return this.warmupPromise;
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
    // listener (and the ~135 MB loaded model) alive for the process
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
      return Promise.reject(
        new Error('intent-classifier worker not initialised'),
      );
    }
    const id = this.nextReqId++;
    // Warmup downloads/loads a ~135MB model; a classify call is a single
    // inference bounded by CHAT_ROUTE_NLI_TIMEOUT_MS so a wedged worker
    // can't pend forever.
    const timeoutMs =
      kind === 'warmup' ? WORKER_WARMUP_TIMEOUT_MS : this.classifyTimeoutMs;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.workerReady = false;
          // Latch like a warmup failure: without this, the next classify()
          // immediately re-warms (spawning a replacement worker) while
          // the wedged one may still be mid-inference — on a persistently
          // slow host that would cycle a new ~135 MB worker per timeout.
          // The latch gives the host FAIL_RETRY_MS to recover; intent
          // degrades to the punctuation heuristic meanwhile.
          if (kind === 'classify') {
            this.failedUntil = Date.now() + FAIL_RETRY_MS;
          }
          reject(
            new Error(
              `intent-classifier '${kind}' RPC timed out after ${timeoutMs}ms`,
            ),
          );
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
