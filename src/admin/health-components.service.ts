import { Injectable } from '@nestjs/common';
import { envFlagNotDisabled } from '../common/env-validation';
import { HealthService, type ReadinessReport } from '../common/health.service';
import type { WarmupStatus } from '../common/warmup-status';
import { EmbedderService } from '../ai/embedder.service';
import { CapabilityProbeService, type LastProbeReport } from '../metrics/capability-probe.service';
import { isConclusive } from '../metrics/capability-probe';
import { IntentClassifierService } from './intent-classifier.service';
import { ChangefeedConsumerService } from '../audit/changefeed-consumer.service';
import type {
  HealthComponent,
  HealthComponentsResponse,
} from '../contracts/admin/health-components.schema';

/**
 * HealthComponentsService — the per-component grid for the admin cockpit
 * (/v1/admin/health/components).
 *
 * The database, scoped-pool and embedder rows are READ from
 * `HealthService.readiness()` — the same report `/ready` answers from — and
 * annotated with the capability probe's last outcome. Nothing here probes
 * on its own. The cockpit used to ping the root pool and ask `isReady()`:
 * it could show a green embedder while `/ready` said "warming", and it had
 * no scoped-pool row at all — the state #502 and #511 were written for was
 * invisible on the one surface an operator looks at. One vocabulary, three
 * surfaces: `/ready`, this grid, and the probe's metrics agree by
 * construction.
 */
@Injectable()
export class HealthComponentsService {
  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly health: HealthService,
    private readonly probe: CapabilityProbeService,
    private readonly embedder: EmbedderService,
    private readonly intent: IntentClassifierService,
    private readonly changefeed: ChangefeedConsumerService,
  ) {}

  async build(): Promise<HealthComponentsResponse> {
    const readiness = await this.health.readiness();
    const last = this.probe.lastReports();
    const components: HealthComponent[] = [
      this.database(readiness),
      this.scopedPool(readiness, last.scoped_read),
      this.embedderRow(readiness, last.embed),
      this.evidenceStoreRow(readiness, last.evidence_store),
      this.intentRow(),
      this.openAiKeyRow(),
      this.changefeedRow(),
      this.calibrationRow(),
    ];
    return {
      generatedAt: new Date().toISOString(),
      components,
    } satisfies HealthComponentsResponse;
  }

  private database(r: ReadinessReport): HealthComponent {
    return {
      name: 'surrealdb',
      status: r.dbOk ? 'ok' : 'unreachable',
      latencyMs: r.detail.dbLatencyMs,
      ...(r.dbOk ? {} : { message: 'liveness ping failed — the same signal /health reports' }),
    };
  }

  /**
   * The caller-facing read path. `disabled` is honest, not green: with no
   * scoped credentials reads run root-authorized and `scopedOk` is
   * vacuously true. `degraded` (not `unreachable`) when the socket is fine
   * but the session cannot authorize — the failure /ready used to miss.
   */
  private scopedPool(r: ReadinessReport, probe: LastProbeReport | undefined): HealthComponent {
    const name = 'scoped pool (brain_caller)';
    if (!r.detail.scopedEnabled) {
      return {
        name,
        status: 'disabled',
        message:
          'SURREALDB_SCOPED_USER/PASS unset — reads run root-authorized; the DB-level ' +
          'fence is inert',
      };
    }
    if (!r.dbOk) return { name, status: 'unreachable', message: 'database unreachable' };
    const probeFailed =
      probe !== undefined && isConclusive(probe.outcome) && probe.outcome !== 'serving';
    return {
      name,
      status: r.scopedOk && !probeFailed ? 'ok' : 'degraded',
      latencyMs: r.detail.scopedLatencyMs,
      message: joinParts(
        r.scopedOk ? 'authorizes reads' : 'cannot authorize reads — unauthorized (see /ready)',
        probeSummary(probe),
      ),
    };
  }

  /**
   * "Ready" here is `/ready`'s definition — the next embed answers in the
   * configured space — and the message carries the warmup bookkeeping
   * (#518) instead of a guess about what the provider is doing.
   */
  private embedderRow(r: ReadinessReport, probe: LastProbeReport | undefined): HealthComponent {
    const stats = this.embedder.cacheStats();
    const name = `embedder (${stats.provider})`;
    const w = r.detail.embedder;
    if (!r.embedderReady) {
      return {
        name,
        status: w.failures > 0 ? 'degraded' : 'warming',
        message: joinParts(
          `${warmupSummary(w, 'the next readiness poll re-arms an attempt')}. Queries that need ` +
            `the configured space are refused (503) until the primary is ready; hybrid search ` +
            `answers lexical-only`,
          probeSummary(probe),
        ),
      };
    }
    const probeFailed =
      probe !== undefined && isConclusive(probe.outcome) && probe.outcome !== 'serving';
    return {
      name,
      status: probeFailed ? 'degraded' : 'ok',
      message: joinParts(`cache size ${stats.size}`, probeSummary(probe)),
    };
  }

  /**
   * The SELECTED blob store (EVIDENCE_STORAGE_SCHEME). `disabled` is the
   * honest word for fs — local disk, nothing remote to probe, and correct
   * only with one replica or a shared volume — not a green that proves
   * nothing. For s3 the row is /ready's live HeadBucket plus the probe's
   * last outcome; `unreachable` carries the probe's own message (which
   * bucket, which endpoint, what the store said), and a selected scheme
   * with no adapter registered reads the same way.
   */
  private evidenceStoreRow(
    r: ReadinessReport,
    probe: LastProbeReport | undefined,
  ): HealthComponent {
    const store = r.detail.evidenceStore;
    const name = `evidence store (${store.scheme})`;
    if (store.error !== null) {
      return {
        name,
        status: 'unreachable',
        ...(store.probed ? { latencyMs: store.latencyMs } : {}),
        message: joinParts(store.error, probeSummary(probe)),
      };
    }
    if (!store.probed) {
      return {
        name,
        status: 'disabled',
        message:
          `EVIDENCE_STORAGE_SCHEME=${store.scheme}: local disk — correct only with one ` +
          `replica or a shared volume; select s3 for a shared store`,
      };
    }
    const probeFailed =
      probe !== undefined && isConclusive(probe.outcome) && probe.outcome !== 'serving';
    return {
      name,
      status: probeFailed ? 'degraded' : 'ok',
      latencyMs: store.latencyMs,
      message: joinParts('bucket answers', probeSummary(probe)),
    };
  }

  /**
   * Not a `/ready` gate — chat routing answers with the punctuation
   * heuristic while the model is missing — but the same warmup bookkeeping
   * as the embedder row, so a model repo that vanished from the Hub reads
   * `degraded` with the reason instead of `warming` forever.
   */
  private intentRow(): HealthComponent {
    const intentStats = this.intent.stats();
    const name = 'intent classifier';
    if (!intentStats.enabled) {
      return { name, status: 'disabled', message: 'CHAT_ROUTE_NLI_ENABLED=0' };
    }
    if (!intentStats.ready) {
      const w = this.intent.warmupStatus();
      return {
        name,
        status: w.failures > 0 ? 'degraded' : 'warming',
        message: joinParts(
          `${warmupSummary(w, 'the next chat-route request re-arms an attempt')}. Chat routing ` +
            `answers with the punctuation-only intent heuristic meanwhile`,
          `model=${intentStats.model}`,
        ),
      };
    }
    return {
      name,
      status: 'ok',
      message: `model=${intentStats.model} cache=${intentStats.cacheSize}`,
    };
  }

  /** Presence only — a ping would burn tokens. */
  private openAiKeyRow(): HealthComponent {
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    return {
      name: 'openai key',
      status: hasOpenAI ? 'ok' : 'disabled',
      message: hasOpenAI ? 'present (not pinged)' : 'OPENAI_API_KEY unset',
    };
  }

  private changefeedRow(): HealthComponent {
    const cf = this.changefeed.stats();
    return {
      name: 'changefeed consumer',
      status: !cf.enabled
        ? 'disabled'
        : cf.lastError
          ? 'degraded'
          : cf.lastPendingRemaining > 100
            ? 'degraded'
            : 'ok',
      message: cf.enabled
        ? `${cf.lastPendingRemaining} pending · ${cf.tickCount} ticks`
        : 'AUDIT_CHANGEFEED_ENABLED=0',
    };
  }

  private calibrationRow(): HealthComponent {
    return {
      name: 'calibration',
      status: envFlagNotDisabled(process.env.CALIBRATION_USE_GOLD_SET) ? 'ok' : 'disabled',
      message: 'see /admin/calibration for ECE + version history',
    };
  }
}

/**
 * `warmup failed 3× (last error: …); next attempt at …` — one wording for
 * every not-ready model row; `rearm` says what triggers an attempt when
 * none is scheduled.
 */
function warmupSummary(w: WarmupStatus, rearm: string): string {
  const attempt = w.failures > 0 ? `warmup failed ${w.failures}×` : 'warming up';
  const detail = w.lastError ? ` (last error: ${w.lastError})` : '';
  const next = w.inFlight
    ? 'attempt in flight'
    : w.nextRetryAt
      ? `next attempt at ${w.nextRetryAt}`
      : rearm;
  return `${attempt}${detail}; ${next}`;
}

/** `probe serving 12s ago`, or the failure with its detail when conclusive. */
function probeSummary(report: LastProbeReport | undefined): string | undefined {
  if (!report) return undefined;
  const ageS = Math.max(0, Math.round((Date.now() - Date.parse(report.at)) / 1000));
  const head = `probe ${report.outcome} ${ageS}s ago`;
  const failed = isConclusive(report.outcome) && report.outcome !== 'serving';
  return failed && report.detail ? `${head}: ${report.detail}` : head;
}

function joinParts(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ');
}
