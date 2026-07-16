import { Controller, Get, Header, Param } from '@nestjs/common';
import { PackRegistryService } from './pack-registry.service';
import { RegistryMetaService } from './registry-meta.service';
import { PublisherProfileService } from './publisher-profile.service';
import { mergeMarketplaceMeta } from './marketplace-meta';
import { renderPublisherPage, renderRegistryPage } from './registry-ui';
import type { RegistryPackSummary } from '../contracts/registry/registry.schema';

/**
 * Public, read-only HTML browser for the global pack registry — a discovery
 * page (like a package index) plus per-publisher pages. NO auth guard: the
 * catalogue is public metadata (pack ids / versions / descriptions /
 * marketplace badges), and a browser can't send a Bearer token. Renders
 * server-side from PackRegistryService so no client token is needed.
 * Machine clients use the JSON API at /v1/registry.
 */
@Controller('registry')
export class RegistryUiController {
  constructor(
    private readonly registry: PackRegistryService,
    private readonly meta: RegistryMetaService,
    private readonly profiles: PublisherProfileService,
  ) {}

  @Get('ui')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async ui(): Promise<string> {
    const packs = await this.registry.list({ limit: 500 });
    return renderRegistryPage(await this.withMarketplaceMeta(packs));
  }

  /** A publisher's public page. An unknown publisher renders the
   *  empty-state page (public surface — no error oracle, no 500). */
  @Get('ui/publisher/:publisher')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async publisher(@Param('publisher') publisher: string): Promise<string> {
    const [profile, packs] = await Promise.all([
      this.profiles.get(publisher),
      this.registry.list({ publisher, limit: 500 }),
    ]);
    return renderPublisherPage({
      publisher,
      profile,
      packs: await this.withMarketplaceMeta(packs),
    });
  }

  private async withMarketplaceMeta(
    packs: RegistryPackSummary[],
  ): Promise<RegistryPackSummary[]> {
    const metaMap = await this.meta.getMetaForPacks(packs.map((p) => p.packId));
    return mergeMarketplaceMeta(packs, metaMap);
  }
}
