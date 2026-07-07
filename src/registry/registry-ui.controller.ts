import { Controller, Get, Header } from '@nestjs/common';
import { PackRegistryService } from './pack-registry.service';
import { renderRegistryPage } from './registry-ui';

/**
 * Public, read-only HTML browser for the global pack registry — a discovery
 * page (like a package index). NO auth guard: the catalogue is public metadata
 * (pack ids / versions / descriptions), and a browser can't send a Bearer
 * token. Renders server-side from PackRegistryService so no client token is
 * needed. Machine clients use the JSON API at /v1/registry.
 */
@Controller('registry')
export class RegistryUiController {
  constructor(private readonly registry: PackRegistryService) {}

  @Get('ui')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async ui(): Promise<string> {
    const packs = await this.registry.list({ limit: 500 });
    return renderRegistryPage(packs);
  }
}
