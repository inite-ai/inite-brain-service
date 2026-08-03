import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled } from '../common/env-validation';

/**
 * Local multilingual NER via @xenova/transformers token-classification.
 *
 * Architecture mirrors IntentClassifierService (Sprint 4.5 in the
 * chat router):
 *   • Lazy-load the ONNX model on module init in the background
 *     (never blocks boot). Default disabled (EXTRACTOR_LOCAL_NER_ENABLED=
 *     "false") so deployments that don't opt in pay no runtime cost.
 *   • Until ready, extract() returns [] and the caller treats that as
 *     "no local entities" — the LLM extraction still runs.
 *   • Once ready, extract() runs the model and returns the entity
 *     spans + types + scores. The extractor emits this as a trace
 *     artifact today; subsequent sprints (E7 skip gate) will consume
 *     it as a fast-path local entity source.
 *
 * Runtime: a dedicated `worker_thread` owns the model (default), so ONNX
 * inference never blocks the main event loop during ingest — same pattern
 * as the local cross-encoder (src/ai/cross-encoder) and the BGE-M3
 * embedder. EXTRACTOR_LOCAL_NER_WORKER=0 keeps the original in-thread
 * path (benchmarks / constrained envs); the test seam
 * (setClassifierForTesting) always drives the in-thread path. Every
 * worker failure — spawn error, RPC timeout, crash — degrades to the
 * feature's existing unavailable behavior: extract() returns [] and the
 * extractor stays LLM-only for NER. A failure latches for FAIL_RETRY_MS
 * so a wedged host isn't asked to reload the model on every call.
 *
 * Default model: Xenova/bert-base-multilingual-cased-ner-hrl
 * (~135MB ONNX). Multilingual (EN/RU/many more), CONLL-2003-style
 * tags (PER, ORG, LOC, MISC). Override with EXTRACTOR_LOCAL_NER_MODEL
 * when a vertical needs custom labels (gliner-style zero-shot would
 * fit that case; this service would change the pipeline type).
 *
 * No hardcoded entity vocabulary — labels come from the model.
 */

type TokenClassificationPipeline = (
  text: string,
  options?: { aggregation_strategy?: string },
) => Promise<RawSpan[]>;

/** One aggregated span as the pipeline (in-thread or worker) returns it. */
interface RawSpan {
  entity_group?: string;
  entity?: string;
  word: string;
  start: number;
  end: number;
  score: number;
}

export interface LocalEntity {
  text: string;
  type: string;
  start: number;
  end: number;
  score: number;
}

const CACHE_SIZE = 1000;
const DEFAULT_MODEL = 'Xenova/bert-base-multilingual-cased-ner-hrl';
const WORKER_WARMUP_TIMEOUT_MS = 120_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 3_000;
const FAIL_RETRY_MS = 5 * 60_000;

@Injectable()
export class LocalNerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LocalNerService.name);
  private readonly modelId: string;
  private readonly enabled: boolean;
  private readonly minScore: number;
  private readonly useWorker: boolean;
  private readonly extractTimeoutMs: number;
  private classifier: TokenClassificationPipeline | null = null;
  private readonly cache = new LRUCache<string, LocalEntity[]>(CACHE_SIZE);

  // Worker runtime (EXTRACTOR_LOCAL_NER_WORKER=1, the default)
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
      envFlagEnabled(this.config.get<string>('EXTRACTOR_LOCAL_NER_ENABLED'));
    this.modelId = this.config.get<string>(
      'EXTRACTOR_LOCAL_NER_MODEL',
      DEFAULT_MODEL,
    );
    this.minScore = parseFloat(
      this.config.get<string>('EXTRACTOR_LOCAL_NER_MIN_SCORE', '0.7'),
    );
    this.useWorker = envFlagEnabled(
      this.config.get<string>('EXTRACTOR_LOCAL_NER_WORKER', '1'),
    );
    this.extractTimeoutMs = parseInt(
      this.config.get<string>(
        'EXTRACTOR_LOCAL_NER_TIMEOUT_MS',
        String(DEFAULT_EXTRACT_TIMEOUT_MS),
      ),
      10,
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Local NER disabled (EXTRACTOR_LOCAL_NER_ENABLED=false). Set to "true" to enable background warmup.',
      );
      return;
    }
    void this.warmup();
  }

  /**
   * Terminate the inference worker thread. A worker_threads.Worker keeps the
   * event loop alive until terminated. Idempotent.
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

  /** Test seam — drive the NER code path without loading the real model. */
  setClassifierForTesting(p: TokenClassificationPipeline | null): void {
    this.classifier = p;
    this.cache.clear();
  }

  /** Load (or await the in-flight load of) the model. Idempotent; a failed
   *  load latches for FAIL_RETRY_MS so we don't re-download every call. */
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
          `Local NER ready (${this.modelId}) — warmup ${Date.now() - start}ms`,
        );
      })
      .catch((e) => {
        this.failedUntil = Date.now() + FAIL_RETRY_MS;
        this.logger.warn(
          `Local NER warmup failed for ${this.modelId}: ${(e as Error).message}; extractor stays LLM-only for NER`,
        );
      })
      .finally(() => {
        this.warmupPromise = null;
      });
    return this.warmupPromise;
  }

  private async warmupInThread(): Promise<void> {
    const transformers = await import('@xenova/transformers');
    this.classifier = (await transformers.pipeline(
      'token-classification',
      this.modelId,
    )) as unknown as TokenClassificationPipeline;
  }

  private async warmupWorker(): Promise<void> {
    // Re-warmup after an extract-RPC timeout must not orphan the previous
    // worker: an un-terminated worker_threads.Worker keeps its message
    // listener (and the loaded model) alive for the process lifetime — one
    // leaked worker per timeout incident. Tear the old one down before
    // spawning its replacement.
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
      this.logger.warn(`local NER worker error: ${err.message}`);
      this.failAllPending(err);
      this.workerReady = false;
    });
    this.worker.on('exit', (code) => {
      if (code !== 0) this.logger.warn(`local NER worker exited (${code})`);
      this.failAllPending(new Error('worker exited'));
      this.workerReady = false;
    });
    await this.rpc<{ ready: boolean }>('warmup', { modelId: this.modelId });
    this.workerReady = true;
  }

  private resolveWorkerPath(): string {
    const distCandidate = join(__dirname, 'local-ner.worker.js');
    if (existsSync(distCandidate)) return distCandidate;
    return join(__dirname, 'local-ner.worker.ts');
  }

  private handleReply(msg: unknown): void {
    const m = msg as { id: number; ok: boolean; result?: unknown; error?: string };
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

  private rpc<R>(kind: 'warmup' | 'extract', payload: unknown): Promise<R> {
    if (!this.worker) {
      return Promise.reject(new Error('local NER worker not initialised'));
    }
    const id = this.nextReqId++;
    // Warmup loads ~135MB from disk/network; an extract call is bounded by
    // its own deadline so a wedged worker can't pend forever.
    const timeoutMs =
      kind === 'warmup' ? WORKER_WARMUP_TIMEOUT_MS : this.extractTimeoutMs;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.workerReady = false;
          // Latch like a warmup failure: without this, the next extract()
          // immediately re-warms (spawning a replacement worker) while the
          // wedged one may still be mid-inference — on a persistently slow
          // host that would cycle a new worker per timeout. The latch gives
          // the host FAIL_RETRY_MS to recover; the extractor stays LLM-only
          // for NER meanwhile.
          if (kind === 'extract') {
            this.failedUntil = Date.now() + FAIL_RETRY_MS;
          }
          reject(
            new Error(`local NER '${kind}' RPC timed out after ${timeoutMs}ms`),
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

  async extract(text: string): Promise<LocalEntity[]> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];
    const cached = this.cache.get(trimmed);
    if (cached) return cached;
    const raw = await this.classify(trimmed);
    if (raw === null) return [];
    const entities: LocalEntity[] = [];
    for (const r of raw) {
      if (r.score < this.minScore) continue;
      entities.push({
        text: r.word,
        type: (r.entity_group ?? r.entity ?? 'MISC').toUpperCase(),
        start: r.start,
        end: r.end,
        score: r.score,
      });
    }
    this.cache.set(trimmed, entities);
    return entities;
  }

  /** Run the pipeline on the active path; null means "unavailable" (the
   *  caller returns [] uncached — the feature's existing disabled behavior). */
  private async classify(trimmed: string): Promise<RawSpan[] | null> {
    // In-thread pipeline (EXTRACTOR_LOCAL_NER_WORKER=0 or the test seam)
    // takes precedence — in worker mode it is never loaded, so no conflict.
    if (this.classifier) {
      try {
        return await this.classifier(trimmed, {
          aggregation_strategy: 'simple',
        });
      } catch (e) {
        this.logger.warn(
          `Local NER extract failed for "${trimmed.slice(0, 60)}": ${(e as Error).message}; returning []`,
        );
        return null;
      }
    }
    if (!this.enabled || !this.useWorker) return null;
    if (!this.workerReady) {
      // Kick a (latched) re-warmup in the background; this call degrades to
      // "no local entities" — same contract as the pre-worker lazy load.
      void this.warmup();
      return null;
    }
    try {
      return await this.rpc<RawSpan[]>('extract', { text: trimmed });
    } catch (e) {
      this.logger.warn(
        `Local NER extract failed for "${trimmed.slice(0, 60)}": ${(e as Error).message}; returning []`,
      );
      return null;
    }
  }

  stats(): {
    enabled: boolean;
    ready: boolean;
    model: string;
    minScore: number;
    cacheSize: number;
  } {
    return {
      enabled: this.enabled,
      ready: this.isReady(),
      model: this.modelId,
      minScore: this.minScore,
      cacheSize: this.cache.size,
    };
  }
}
