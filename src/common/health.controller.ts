import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HealthService } from './health.service';

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
      version: '0.1.0',
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
    const { dbOk, embedderReady, ready } = await this.healthService.readiness();
    if (!ready) {
      throw new ServiceUnavailableException({
        ready: false,
        checks: {
          surrealdb: dbOk ? 'ok' : 'unreachable',
          embedder: embedderReady ? 'ok' : 'warming',
        },
      });
    }
    return {
      ready: true,
      checks: { surrealdb: 'ok', embedder: 'ok' },
    };
  }
}
