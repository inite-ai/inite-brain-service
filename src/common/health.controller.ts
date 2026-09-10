import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';
import { SERVICE_VERSION } from './service-version';

/**
 * Liveness and readiness, exempt from rate limiting.
 *
 * Anonymous requests are tracked by IP, and behind a reverse proxy every
 * anonymous request in the world shares the proxy's IP — including the
 * edge's own health probe, which runs every 3s. Under load the shared
 * bucket fills, the probe gets a 429, the edge marks the only replica
 * unhealthy and takes it out of rotation, and every caller gets a 503
 * from a service that is perfectly fine. Observed in production: Traefik
 * logging `Health check failed … received error status code: 429` in a
 * loop while /ready answered 200 from inside the container.
 *
 * A probe must report the process's state, not the traffic's. These two
 * routes do no work worth rationing — one reads a cached liveness flag,
 * the other four readiness checks — so they are exempt.
 */
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // Liveness — answers true as soon as Nest is up, so the container
  // is considered alive while warmups (BGE-M3, local NER, intent
  // classifier) are still resolving in the background. The compose
  // healthcheck uses this.
  @Get('health')
  async health() {
    const { dbOk } = await this.healthService.liveness();
    if (this.healthService.isShuttingDown()) {
      // The balancer health-checks THIS path (traefik loadbalancer
      // healthcheck.path=/health, deliberately not /ready), so a leaving
      // replica has to fail it: answering 200 until the socket closes
      // costs a whole check interval of 502s.
      throw new ServiceUnavailableException({
        status: 'shutting_down',
        service: 'inite-brain-service',
        version: SERVICE_VERSION,
        timestamp: new Date().toISOString(),
        checks: { surrealdb: dbOk ? 'ok' : 'unreachable' },
      });
    }
    return {
      status: dbOk ? 'ok' : 'degraded',
      service: 'inite-brain-service',
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
      checks: {
        surrealdb: dbOk ? 'ok' : 'unreachable',
      },
    };
  }

  // Readiness — answers true only when the request-path dependencies
  // are warm enough to take production traffic. Split from /health so
  // a load balancer (or k8s readinessProbe) can hold traffic off while
  // the local embedder is downloading ONNX weights on first boot,
  // without the container looking unhealthy + getting recycled by the
  // liveness probe. Returns 503 when not ready.
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready() {
    const { dbOk, scopedOk, embedderReady, evidenceStoreOk, ready, detail } =
      await this.healthService.readiness();
    if (!ready) {
      const store = detail.evidenceStore;
      throw new ServiceUnavailableException({
        ready: false,
        // Set from the first shutdown hook on: the checks may all be fine,
        // the replica is simply leaving the pool.
        shuttingDown: this.healthService.isShuttingDown(),
        checks: {
          surrealdb: dbOk ? 'ok' : 'unreachable',
          // Distinct from `surrealdb`: the socket can be perfectly healthy
          // while the scoped session has gone anonymous, which is exactly
          // the failure /ready used to miss.
          scopedPool: scopedOk ? 'ok' : 'unauthorized',
          embedder: embedderReady ? 'ok' : 'warming',
          // The SELECTED blob store: fs is local disk and always ok here;
          // s3 is a live HeadBucket. Its own message rides along below so
          // the 503 names WHICH bucket and WHY instead of sending the
          // operator to the logs.
          evidenceStore: evidenceStoreOk ? 'ok' : 'unreachable',
        },
        ...(evidenceStoreOk ? {} : { evidenceStore: { scheme: store.scheme, error: store.error } }),
      });
    }
    return {
      ready: true,
      checks: { surrealdb: 'ok', scopedPool: 'ok', embedder: 'ok', evidenceStore: 'ok' },
    };
  }
}
