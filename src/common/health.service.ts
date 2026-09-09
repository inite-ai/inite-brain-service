import { Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';

export interface LivenessReport {
  dbOk: boolean;
}

export interface ReadinessReport {
  dbOk: boolean;
  /** The caller-facing read path (scoped pool) can still authorize a query. */
  scopedOk: boolean;
  embedderReady: boolean;
  ready: boolean;
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
    const dbOk = await this.surreal.ping().catch(() => false);
    return { dbOk };
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
    const dbOk = await this.surreal.ping().catch(() => false);
    const scopedOk = dbOk ? await this.surreal.pingScoped().catch(() => false) : false;
    const embedderReady = this.embedder.isReady();
    return { dbOk, scopedOk, embedderReady, ready: dbOk && scopedOk && embedderReady };
  }
}
