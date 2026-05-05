import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Prometheus scrape endpoint. Unauthenticated by design — the standard
   * deployment pattern is to firewall /metrics off the public interface
   * (e.g. only the prom-scraper subnet can reach it). If we ever expose
   * this on the public surface, gate behind ApiKeyGuard with a dedicated
   * `brain:metrics` scope.
   */
  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    const { contentType, body } = await this.metrics.serialize();
    res.set('Content-Type', contentType).send(body);
  }
}
