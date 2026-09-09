import { Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService, type EmbedderWarmupStatus } from '../ai/embedder.service';

export interface LivenessReport {
  dbOk: boolean;
  /** Round-trip of the liveness ping, for the cockpit's latency column. */
  dbLatencyMs: number;
}

/**
 * The checks `/ready` gates on. Each one has a CONTINUOUS counterpart in the
 * capability probe (`CAPABILITY_COVERAGE` is typed on these keys, and a
 * source-level gate in the probe's spec catches a check added without one)
 * — a readiness check that is polled only at deploy time is the blindness
 * #502 produced.
 */
export interface ReadinessChecks {
  dbOk: boolean;
  /** The caller-facing read path (scoped pool) can still authorize a query. */
  scopedOk: boolean;
  embedderReady: boolean;
}

/** Measurements behind the checks — what the cockpit shows next to them. */
export interface ReadinessDetail {
  dbLatencyMs: number;
  /**
   * The scoped (`brain_caller`) pool is configured. When false, reads route
   * to root and `scopedOk` is vacuously true — a surface must say
   * "disabled", not "ok", for that case.
   */
  scopedEnabled: boolean;
  scopedLatencyMs: number;
  /** Warmup bookkeeping behind `embedderReady`: attempts, last error, next retry. */
  embedder: EmbedderWarmupStatus;
}

/**
 * THE readiness vocabulary. `/ready`, the admin cockpit
 * (/v1/admin/health/components) and the capability probe all read this one
 * report, so "embedder ready" and "scoped reads work" cannot mean three
 * different things on three surfaces (they did: the cockpit pinged root and
 * asked `isReady()`, and never showed the scoped pool at all).
 */
export interface ReadinessReport extends ReadinessChecks {
  ready: boolean;
  detail: ReadinessDetail;
}

/**
 * Health probe logic, lifted out of HealthController so the controller
 * stays pure HTTP plumbing and does not import from src/db (layer-purity
 * gate — import/no-restricted-paths). The DB connection ping and embedder
 * warmup check live here; the controller just shapes the HTTP response.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  /** Liveness — is the DB connection reachable right now. */
  async liveness(): Promise<LivenessReport> {
    const started = Date.now();
    const dbOk = await this.surreal.ping().catch(() => false);
    return { dbOk, dbLatencyMs: Date.now() - started };
  }

  /**
   * Readiness — request-path dependencies warm enough for production
   * traffic: DB reachable, the CALLER-FACING read path still authorized,
   * and the embedder finished its (ONNX) warmup.
   *
   * `ping()` alone is not enough: it calls `version()`, which SurrealDB
   * answers for an anonymous session too. During the 2026-09-08
   * scoped-session-expiry outage that made /ready green while every read
   * failed with "Anonymous access not allowed". `pingScoped()` runs an
   * authorization-gated statement on a scoped connection, so deployment
   * checks and readiness-aware balancers can detect a broken read path.
   */
  async readiness(): Promise<ReadinessReport> {
    const { dbOk, dbLatencyMs } = await this.liveness();
    const scopedEnabled = this.surreal.scopedPoolEnabled();
    const scopedStarted = Date.now();
    const scopedOk = dbOk ? await this.surreal.pingScoped().catch(() => false) : false;
    const scopedLatencyMs = Date.now() - scopedStarted;
    const embedderReady = this.embedder.isReady();
    const embedder = this.embedder.warmupStatus();
    return {
      dbOk,
      scopedOk,
      embedderReady,
      ready: dbOk && scopedOk && embedderReady,
      detail: { dbLatencyMs, scopedEnabled, scopedLatencyMs, embedder },
    };
  }
}
