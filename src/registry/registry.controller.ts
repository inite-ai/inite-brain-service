import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { PackRegistryService } from './pack-registry.service';
import { RegistryMetaService } from './registry-meta.service';
import { PublisherProfileService } from './publisher-profile.service';
import { mergeMarketplaceMeta } from './marketplace-meta';
import type {
  PublisherResponse,
  RegistryListResponse,
  RegistryManifestResponse,
  RegistryPackSummary,
  RegistryVersionsResponse,
} from '../contracts/registry/registry.schema';

/**
 * Discovery reads over the GLOBAL Domain Pack registry (docs/domain-packs.md).
 * Any authenticated tenant may browse the catalogue (brain:read) — publishing +
 * installing are separate, privileged surfaces. The catalogue is shared across
 * all tenants (system DB), so these reads are tenant-agnostic. Listings carry
 * the instance-local marketplace metadata (featured / paid / displayPrice,
 * migration 0066) stamped over the registry rows.
 */
@Controller('v1/registry')
@UseGuards(ApiKeyGuard)
export class RegistryController {
  constructor(
    private readonly registry: PackRegistryService,
    private readonly meta: RegistryMetaService,
    private readonly profiles: PublisherProfileService,
  ) {}

  @Get('packs')
  @RequireScopes('brain:read')
  async list(
    @Query()
    query: {
      q?: string;
      publisher?: string;
      tag?: string;
      limit?: string;
      offset?: string;
    },
  ): Promise<RegistryListResponse> {
    const packs = await this.registry.list({
      q: query.q,
      publisher: query.publisher,
      tag: query.tag,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
    return { packs: await this.withMarketplaceMeta(packs) };
  }

  @Get('packs/:packId')
  @RequireScopes('brain:read')
  async versions(@Param('packId') packId: string): Promise<RegistryVersionsResponse> {
    return this.registry.getVersions(packId);
  }

  /** A publisher's public page as JSON: profile (when one was written) +
   *  their catalogue entries. 404 only when the publisher is entirely
   *  unknown — no profile AND no packs. */
  @Get('publishers/:publisher')
  @RequireScopes('brain:read')
  @PolicyAction('rest.registry.publisher.get')
  async publisher(@Param('publisher') publisher: string): Promise<PublisherResponse> {
    const [profile, packs] = await Promise.all([
      this.profiles.get(publisher),
      this.registry.list({ publisher }),
    ]);
    if (!profile && packs.length === 0) {
      throw new NotFoundException(`publisher "${publisher}" not found`);
    }
    return {
      publisher,
      profile,
      packs: await this.withMarketplaceMeta(packs),
    };
  }

  @Get('packs/:packId/:version')
  @RequireScopes('brain:read')
  async manifest(
    @Param('packId') packId: string,
    @Param('version') version: string,
  ): Promise<RegistryManifestResponse> {
    // `latest` is a convenience alias for "the latest non-yanked version".
    const resolved = await this.registry.getManifest(
      packId,
      version === 'latest' ? undefined : version,
    );
    if (!resolved) {
      throw new NotFoundException(`pack "${packId}" ${version} not found in the registry`);
    }
    return resolved;
  }

  private async withMarketplaceMeta(packs: RegistryPackSummary[]): Promise<RegistryPackSummary[]> {
    const metaMap = await this.meta.getMetaForPacks(packs.map((p) => p.packId));
    return mergeMarketplaceMeta(packs, metaMap);
  }
}
