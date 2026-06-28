import { Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';

export interface LivenessReport {
  dbOk: boolean;
}

export interface ReadinessReport {
  dbOk: boolean;
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
   * traffic: DB reachable AND the embedder finished its (ONNX) warmup.
   */
  async readiness(): Promise<ReadinessReport> {
    const dbOk = await this.surreal.ping().catch(() => false);
    const embedderReady = this.embedder.isReady();
    return { dbOk, embedderReady, ready: dbOk && embedderReady };
  }
}
