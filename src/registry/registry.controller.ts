import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PackRegistryService } from './pack-registry.service';
import type {
  RegistryListResponse,
  RegistryManifestResponse,
  RegistryVersionsResponse,
} from '../contracts/registry/registry.schema';

/**
 * Discovery reads over the GLOBAL Domain Pack registry (docs/domain-packs.md).
 * Any authenticated tenant may browse the catalogue (brain:read) — publishing +
 * installing are separate, privileged surfaces. The catalogue is shared across
 * all tenants (system DB), so these reads are tenant-agnostic.
 */
@Controller('v1/registry')
@UseGuards(ApiKeyGuard)
export class RegistryController {
  constructor(private readonly registry: PackRegistryService) {}

  @Get('packs')
  @RequireScopes('brain:read')
  async list(
    @Query()
    query: { q?: string; publisher?: string; tag?: string; limit?: string },
  ): Promise<RegistryListResponse> {
    const packs = await this.registry.list({
      q: query.q,
      publisher: query.publisher,
      tag: query.tag,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });
    return { packs };
  }

  @Get('packs/:packId')
  @RequireScopes('brain:read')
  async versions(
    @Param('packId') packId: string,
  ): Promise<RegistryVersionsResponse> {
    return this.registry.getVersions(packId);
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
      throw new NotFoundException(
        `pack "${packId}" ${version} not found in the registry`,
      );
    }
    return resolved;
  }
}
