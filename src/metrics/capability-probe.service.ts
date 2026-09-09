import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import { EmbedderService } from '../ai/embedder.service';
import { MetricsService } from './metrics.service';
import { envFlagEnabled } from '../common/env-validation';
import {
  CAPABILITY_NAMES,
  classifyProbeFailure,
  isConclusive,
  probeErrorDetail,
  type ProbeReport,
} from './capability-probe';

/** Default probe cadence. One minute is the detection latency floor. */
const DEFAULT_INTERVAL_MS = 60_000;
/** Below this the probe becomes load rather than measurement. */
const MIN_INTERVAL_MS = 5_000;
/**
 * Per-probe deadline. Longer than the pool's own 10s acquire timeout (so a
 * saturated pool still classifies as `busy` rather than as this deadline),
 * short enough that a wedged capability cannot hold the tick past the next.
 */
const PROBE_DEADLINE_MS = 15_000;

/**
 * The cheapest statement that exercises the WHOLE scoped read path:
 * acquire → renew-or-fail-closed → `use(co_<tenant>)` → schema check →
 * `LET $caller_scopes` → an authorization-gated read of a real table.
 *
 * `LIMIT 1` with no WHERE, and the result is deliberately NOT asserted to
 * be non-empty — a tenant with zero facts is a healthy tenant, and a probe
 * that pages on an empty table is a probe that gets switched off. The
 * question is "was this authorized", not "is there data".
 */
const SCOPED_READ_STATEMENT = 'SELECT VALUE id FROM knowledge_fact LIMIT 1';

/** Scope set bound for the probe read — what an ordinary reader carries. */
const PROBE_SCOPES = ['brain:read'] as const;

/** Short and stable: the embedder is measured on the width it returns. */
const EMBED_PROBE_TEXT = 'brain capability probe';

const RUNBOOK = 'runbook: docs/operations.md § Capability probes';

/** What an operator should do about a scoped read path that cannot authorize. */
const REMEDY =
  'Reads are failing on THIS pod while writes and /health may still answer; ' +
  'restart it to re-establish the session, then check SURREALDB_SCOPED_USER/PASS ' +
  "and that migration 0005's brain_caller still exists";

/**
 * CapabilityProbeService — periodically RUNS each capability the service
 * claims and publishes what happened (see capability-probe.ts for the
 * failure class and the design rules).
 *
 * ── Why every pod, with no leader lease ──────────────────────────────────
 * The failure this exists for is per-PROCESS: a scoped pool's session
 * lapses inside one node process, and its neighbours are unaffected. A
 * leader-elected probe would prove one pod healthy and say nothing about
 * the other four. So every pod probes itself (the MemoryQualityService
 * precedent, for a different reason) and the alert aggregates with
 * `min by (capability)` — one bad pod is enough to page.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────
 * Per pod per minute: one indexless `LIMIT 1` read, and one embed of a
 * four-word string. On `EMBEDDER_PROVIDER=bge-m3` the embed is local CPU;
 * on `openai` it is a real (tiny) API call that shows up in
 * `brain_openai_calls_total` — raise `CAPABILITY_PROBE_INTERVAL_MS` if that
 * matters more than a 60s detection floor.
 */
@Injectable()
export class CapabilityProbeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CapabilityProbeService.name);
  private readonly enabled = envFlagEnabled(process.env.CAPABILITY_PROBE_ENABLED);
  private readonly intervalMs = Math.max(
    MIN_INTERVAL_MS,
    parseInt(process.env.CAPABILITY_PROBE_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS), 10) ||
      DEFAULT_INTERVAL_MS,
  );
  private readonly tenantOverride = process.env.CAPABILITY_PROBE_TENANT?.trim() || undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token and cannot be folded into an options object without breaking DI
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly metrics: MetricsService,
    // Optional so a process that does not wire the AI module (and every
    // unit fixture) still gets the scoped-read probe; the embed probe then
    // reports `skipped` rather than pretending to have run.
    @Optional() private readonly embedder?: EmbedderService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    // unref: a monitoring timer must never be the reason a process (or a
    // jest worker) refuses to exit.
    // Publish the armed-at series for every declared capability BEFORE the
    // first tick. Without it a capability that never once succeeded has no
    // series for the staleness alert to measure, and noDataState: OK turns
    // "broken since boot" into silence — the exact failure the probe exists
    // to catch.
    const armedAt = Date.now() / 1000;
    for (const capability of CAPABILITY_NAMES) {
      this.metrics.capabilityProbeArmed.set({ capability }, armedAt);
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    this.logger.log(
      `capability probe armed: [${CAPABILITY_NAMES.join(', ')}] every ${this.intervalMs}ms ` +
        `(tenant=${this.probeTenant() ?? 'none yet'})`,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass over every capability. Public so tests and an operator-driven
   * check can run exactly what the timer runs — no second code path that
   * could disagree with the one being monitored.
   */
  async runOnce(): Promise<ProbeReport[]> {
    const reports = [await this.probeScopedRead(), await this.probeEmbed()];
    for (const report of reports) this.publish(report);
    return reports;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      // A tick that overruns its interval means a capability is hanging.
      // Stacking probes would make that worse; the last-success gauge is
      // what surfaces it (the up-gauge would otherwise sit at its last
      // value forever, which is the exact blindness this service exists
      // to remove).
      this.logger.warn(`capability probe still running after ${this.intervalMs}ms — tick skipped`);
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (e) {
      // runOnce swallows per-capability failures; reaching here means the
      // prober itself broke, which must not kill the timer.
      this.logger.error(`capability probe tick failed: ${probeErrorDetail(e)}`);
    } finally {
      this.running = false;
    }
  }

  private publish(report: ProbeReport): void {
    this.metrics.recordCapabilityProbe(report.capability, report.outcome);
    if (report.outcome === 'skipped') {
      // Nothing to exercise here (no embedder wired, no tenant yet): a
      // capability that legitimately never runs must not read as "armed and
      // never succeeded" to the staleness alert. Withdraw its armed series;
      // a later tick that does run re-publishes success on its own.
      this.metrics.capabilityProbeArmed.remove({ capability: report.capability });
    }
    if (report.outcome === 'serving') return;
    const line = `capability '${report.capability}' is ${report.outcome}: ${report.detail ?? '—'}`;
    if (isConclusive(report.outcome)) this.logger.error(`${line} — ${RUNBOOK}`);
    else this.logger.debug(line);
  }

  /**
   * The canary tenant. Explicit override first, else the first id of the
   * known roster (static keys before registry ids — a stable ordering, so
   * the probe hits the same database every tick and its cost is bounded).
   *
   * One tenant, not all of them: the scoped session is shared by every
   * tenant on the pod, so a per-tenant sweep would multiply series and DB
   * load by the roster size to re-answer the same question.
   */
  private probeTenant(): string | undefined {
    if (this.tenantOverride) return this.tenantOverride;
    return this.apiKeys.knownCompanyIds()[0];
  }

  private async probeScopedRead(): Promise<ProbeReport> {
    const tenant = this.probeTenant();
    if (!tenant) {
      return {
        capability: 'scoped_read',
        outcome: 'skipped',
        detail: 'no tenant in the roster to probe (set CAPABILITY_PROBE_TENANT to pin one)',
      };
    }
    try {
      await withDeadline(
        this.surreal.withScopedCompany(tenant, PROBE_SCOPES, (db) =>
          db.query(SCOPED_READ_STATEMENT),
        ),
        PROBE_DEADLINE_MS,
      );
      return { capability: 'scoped_read', outcome: 'serving' };
    } catch (e) {
      const outcome = classifyProbeFailure(e);
      const where = `scoped pool, tenant=${tenant} (db=co_${tenant}): ${probeErrorDetail(e)}`;
      // The remedy belongs only on a CONCLUSIVE outcome. Telling an
      // operator to restart a pod because its pool was briefly saturated
      // is how a monitor teaches people to ignore it.
      return {
        capability: 'scoped_read',
        outcome,
        detail: outcome === 'busy' ? `${where} (saturation, not a failure)` : `${where}. ${REMEDY}`,
      };
    }
  }

  /**
   * Exercise the embedder and measure the WIDTH of what came back against
   * the configured (primary) space.
   *
   * Not `isReady()`: that is the component's opinion of itself, and in
   * #503 the opinion was green from the first millisecond of boot while
   * every vector came back 1536 wide for a 1024-wide corpus. A probe that
   * asks the same question as the thing it monitors inherits its bugs.
   * `embedUncached` for the same reason — a cached answer proves only that
   * the cache works.
   */
  private async probeEmbed(): Promise<ProbeReport> {
    const embedder = this.embedder;
    if (!embedder) {
      return {
        capability: 'embed',
        outcome: 'skipped',
        detail: 'no embedder in this process',
      };
    }
    try {
      const expected = embedder.primaryDimensions();
      const vector = await withDeadline(
        embedder.embedUncached(EMBED_PROBE_TEXT),
        PROBE_DEADLINE_MS,
      );
      if (vector.length !== expected) {
        return {
          capability: 'embed',
          outcome: 'degraded',
          detail:
            `embedder answered ${vector.length}-wide, configured space is ${expected}-wide ` +
            `(serving '${embedder.activeSpaceId()}'). Vector WRITES are refused until the ` +
            `primary warms up; if this persists the warmup failed — check the boot log for ` +
            `the bge-m3 model pull and consider EMBEDDER_PROVIDER=openai to roll back`,
        };
      }
      return { capability: 'embed', outcome: 'serving' };
    } catch (e) {
      return {
        capability: 'embed',
        outcome: classifyProbeFailure(e),
        detail: `embedder: ${probeErrorDetail(e)}`,
      };
    }
  }
}

/**
 * Bound a probe's wall-clock. `Promise.race` attaches a handler to `p`
 * immediately, so a rejection arriving after the deadline is still handled
 * and cannot surface as an unhandled rejection.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`capability probe timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
