import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { PolicyKeysService } from '../policy/policy-keys.service';
import type { AdminKeysResponse } from '../contracts/admin/policy-tools.schema';

/**
 * Read-only tenant key inventory for the ABAC admin UI (attach drawer,
 * Key Lens subject picker). Static keys only, hashes never plaintext;
 * per-key CRUD stays a future increment — issuing keys is the
 * auth-service's job.
 */
@Controller('v1/admin/keys')
@UseGuards(ApiKeyGuard)
export class AdminKeysController {
  constructor(private readonly keys: PolicyKeysService) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest): Promise<AdminKeysResponse> {
    const keys = await this.keys.listKeys(req.brainAuth.companyId);
    return { keys } satisfies AdminKeysResponse;
  }
}
