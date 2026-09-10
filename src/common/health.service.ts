import { Inject, Injectable, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService, type EmbedderWarmupStatus } from '../ai/embedder.service';
import { evidenceStorageScheme } from './evidence-flags';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  type EvidenceStorageRegistry,
} from '../evidence/storage/storage-adapter';

/**
 * Bound on the live blob-store probe inside one readiness poll. Shorter
 * than the adapter's own request abort (10s): a wedged endpoint must not
 * hold /ready open past what a balancer waits for.
 */
const STORE_PROBE_DEADLINE_MS = 5_000;

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
  /**
   * The SELECTED blob store (EVIDENCE_STORAGE_SCHEME) can serve: a live
   * HeadBucket for s3; vacuously true for fs, which is local disk with
   * nothing remote to ask. False also when the selected scheme has no
   * adapter registered — uploads would 503, so the deploy must not go
   * green.
   */
  evidenceStoreOk: boolean;
}

/** The selected blob store's probe, as `/ready` and the cockpit show it. */
export interface EvidenceStoreDetail {
  /** EVIDENCE_STORAGE_SCHEME — which adapter NEW uploads land in. */
  scheme: string;
  /**
   * The selected adapter has a remote store and was asked. When false
   * `evidenceStoreOk` is vacuous (fs = local disk) unless `error` names
   * a missing adapter — a surface must say "local", not "ok", for the
   * vacuous case.
   */
  probed: boolean;
  latencyMs: number;
  /** The probe's own message when the check failed; null otherwise. */
  error: string | null;
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
  /** The live probe behind `evidenceStoreOk`: which store, whether asked, what it said. */
  evidenceStore: EvidenceStoreDetail;
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
  private shuttingDown = false;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    // @Optional: unit fixtures construct this positionally, and a process
    // without the storage registry wired gets a vacuous store check
    // rather than a DI failure. In production the registry is @Global.
    @Optional()
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    private readonly storage?: EvidenceStorageRegistry,
  ) {}

  /**
   * Called the moment shutdown begins: from here `/health` and `/ready`
   * both answer 503 so the balancer drains this replica within one
   * health-check interval while it still serves in-flight requests.
   * Traefik health-checks `/health` (deploy-brain.yml), which is why
   * liveness has to say it too. One-way — a shutting-down process never
   * becomes ready again.
   */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

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
    const evidenceStore = await this.evidenceStore();
    const evidenceStoreOk = evidenceStore.error === null;
    return {
      dbOk,
      scopedOk,
      embedderReady,
      evidenceStoreOk,
      // A shutting-down replica is not ready however green its checks are.
      ready: !this.shuttingDown && dbOk && scopedOk && embedderReady && evidenceStoreOk,
      detail: { dbLatencyMs, scopedEnabled, scopedLatencyMs, embedder, evidenceStore },
    };
  }

  /**
   * The SELECTED blob store (EVIDENCE_STORAGE_SCHEME), probed live — a
   * HeadBucket for s3 — under a deadline, so a wedged endpoint cannot
   * hold /ready open. fs has no remote dependency: not probed, vacuously
   * ok. A selected scheme whose adapter is not registered (s3 with
   * EVIDENCE_S3_BUCKET unset at boot) is NOT ok: every upload would 503,
   * and the deploy must hear that here rather than from the first caller.
   * No registry at all (a process without the storage module) is vacuous,
   * the same rule as the scoped pool when it is not configured.
   */
  private async evidenceStore(): Promise<EvidenceStoreDetail> {
    const scheme = evidenceStorageScheme();
    if (!this.storage) return { scheme, probed: false, latencyMs: 0, error: null };
    const adapter = this.storage.get(scheme);
    if (!adapter) {
      return {
        scheme,
        probed: false,
        latencyMs: 0,
        error:
          `no '${scheme}' evidence storage adapter is registered — ` +
          `EVIDENCE_STORAGE_SCHEME=${scheme} needs its store configured at boot ` +
          `(EVIDENCE_S3_BUCKET); uploads answer 503 until then`,
      };
    }
    if (!adapter.probe) return { scheme, probed: false, latencyMs: 0, error: null };
    const started = Date.now();
    try {
      await withDeadline(adapter.probe(), STORE_PROBE_DEADLINE_MS);
      return { scheme, probed: true, latencyMs: Date.now() - started, error: null };
    } catch (e) {
      return {
        scheme,
        probed: true,
        latencyMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

/**
 * Bound a probe's wall-clock. `Promise.race` attaches a handler to `p`
 * immediately, so a rejection arriving after the deadline is still
 * handled and cannot surface as an unhandled rejection.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`evidence store probe timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
