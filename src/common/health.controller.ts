import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';
import { SERVICE_VERSION } from './service-version';

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
    const { dbOk, scopedOk, embedderReady, ready } = await this.healthService.readiness();
    if (!ready) {
      throw new ServiceUnavailableException({
        ready: false,
        checks: {
          surrealdb: dbOk ? 'ok' : 'unreachable',
          // Distinct from `surrealdb`: the socket can be perfectly healthy
          // while the scoped session has gone anonymous, which is exactly
          // the failure /ready used to miss.
          scopedPool: scopedOk ? 'ok' : 'unauthorized',
          embedder: embedderReady ? 'ok' : 'warming',
        },
      });
    }
    return {
      ready: true,
      checks: { surrealdb: 'ok', scopedPool: 'ok', embedder: 'ok' },
    };
  }
}
