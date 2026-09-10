import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HealthService } from './health.service';
import { shutdownTracing } from './tracing';

/**
 * Shutdown budget, inside compose `stop_grace_period: 30s`:
 *   0 s    /health and /ready answer 503 (onModuleDestroy, the first hook
 *          of the lifecycle) — the balancer stops routing here within one
 *          health-check interval
 *   6 s    READINESS_DRAIN_MS: keep serving while it notices (signal-driven only)
 *   ≤12 s  WorkerLoopService drains in-flight dispatches, hands back any
 *          claim that outlived the budget, then releases its lease
 *   then   HTTP close, OTel flush, pool close
 *   25 s   HARD_STOP_MS: process.exit(1) if any of that hangs, ahead of
 *          docker's SIGKILL
 */
const READINESS_DRAIN_MS = 6_000;
const HARD_STOP_MS = 25_000;

/**
 * Owns the process-level shutdown sequence so it runs exactly once, through
 * Nest's lifecycle (enableShutdownHooks) rather than a second signal
 * listener racing app.close() with itself. Registered on the root module:
 * Nest calls each shutdown phase root-module-first, so the readiness flip
 * and the drain precede every feature module's own hook.
 */
@Injectable()
export class GracefulShutdownService
  implements OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(GracefulShutdownService.name);
  private hardStop: NodeJS.Timeout | null = null;

  constructor(private readonly health: HealthService) {}

  onModuleDestroy(): void {
    this.health.markShuttingDown();
    this.hardStop = setTimeout(() => {
      this.logger.error(`Shutdown still running after ${HARD_STOP_MS} ms; forcing exit`);
      process.exit(1);
    }, HARD_STOP_MS);
    this.hardStop.unref();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    // A programmatic close (tests, tooling) has no balancer to drain for.
    if (!signal) return;
    this.logger.log(
      `${signal} received — /health and /ready are 503; serving ${READINESS_DRAIN_MS} ms more`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, READINESS_DRAIN_MS).unref());
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await shutdownTracing();
    // Signal-driven: the deadline stays armed until the process is gone.
    if (!signal && this.hardStop) clearTimeout(this.hardStop);
  }
}
