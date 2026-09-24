import { Injectable, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from '../../metrics/metrics.service';

const NAME = 'brain_decisions_total';

/**
 * The decision plane's own counter, on the service's registry.
 *
 * It lives here rather than beside the other fifty in MetricsService for one
 * reason: that file is a god-file at its 800-line ceiling, and a subsystem that
 * owns a metric is a real seam — the registry stays single, so /metrics is
 * unchanged, and the plane's instrumentation ships with the plane.
 *
 * `acted` — the lane used the answer. `escalated` — it came back below the
 * lane's confidence floor and the reasoning model got the case. `unanswered` —
 * the plane returned nothing (no key, a failed call, a short answer map) and
 * the lane took the path it had. Without the split the plane is invisible in
 * production: the cheap decision and the expensive fallback it triggered land
 * in the same token counter.
 */
@Injectable()
export class DecisionMetrics {
  private readonly counter: Counter<'lane' | 'outcome'> | undefined;

  constructor(@Optional() metrics?: MetricsService) {
    if (!metrics) return;
    // A second instance (tests, a re-created module) must not throw on a
    // duplicate registration — reuse whatever the registry already holds.
    const existing = metrics.registry.getSingleMetric(NAME) as
      Counter<'lane' | 'outcome'> | undefined;
    this.counter =
      existing ??
      new Counter({
        name: NAME,
        help: 'System One decisions by lane and what the lane did with the answer',
        labelNames: ['lane', 'outcome'] as const,
        registers: [metrics.registry],
      });
  }

  count(lane: string, outcome: 'acted' | 'escalated' | 'unanswered'): void {
    this.counter?.inc({ lane, outcome });
  }
}
