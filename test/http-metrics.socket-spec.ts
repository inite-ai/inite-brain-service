import { Controller, Get, NotFoundException, Param, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { Registry } from 'prom-client';
import { httpMetrics, httpMetricsMiddleware } from '../src/metrics/http-metrics';

/**
 * The route label depends on Express having matched a route by the time the
 * response finishes; a unit fake cannot prove that. A real Nest app over
 * loopback does: a templated route is labelled by its template, an error
 * keeps its route, and a path no route matches is `unmatched`.
 */
@Controller('v1/facts')
class FactsProbeController {
  @Get(':id')
  get(@Param('id') id: string) {
    if (id === 'missing') throw new NotFoundException();
    return { id };
  }
}

@Module({ controllers: [FactsProbeController] })
class ProbeModule {}

describe('HTTP metrics on a real Nest app', () => {
  let app: INestApplication;
  let base = '';
  const registry = new Registry();

  beforeAll(async () => {
    const nest = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
    nest.use(httpMetricsMiddleware(httpMetrics(registry)));
    await nest.listen(0, '127.0.0.1');
    app = nest;
    base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('labels by route template, keeps the route on an error, and folds unknown paths', async () => {
    await fetch(`${base}/v1/facts/knowledge_fact:abc`);
    await fetch(`${base}/v1/facts/knowledge_fact:def`);
    await fetch(`${base}/v1/facts/missing`);
    await fetch(`${base}/nope/at/all`);
    // The finish listener runs after the body is flushed; let it land.
    await new Promise((r) => setTimeout(r, 50));
    const values =
      (await registry.getMetricsAsJSON()).find((m) => m.name === 'brain_http_requests_total')
        ?.values ?? [];
    const byKey = Object.fromEntries(
      values.map((v) => [`${v.labels.route} ${v.labels.status_class}`, v.value]),
    );
    expect(byKey).toEqual({
      '/v1/facts/:id 2xx': 2,
      '/v1/facts/:id 4xx': 1,
      'unmatched 4xx': 1,
    });
  });
});
