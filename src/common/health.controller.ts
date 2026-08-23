import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HealthService } from './health.service';

// Resolved once at boot. Both deploy shapes run from the directory that
// holds package.json (Docker WORKDIR /app with `node dist/main.js`; dev
// `nest start` from the repo root), so cwd is the stable anchor — the
// compiled __dirname lives under dist/ where the manifest never ships.
const SERVICE_VERSION = ((): string => {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

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
