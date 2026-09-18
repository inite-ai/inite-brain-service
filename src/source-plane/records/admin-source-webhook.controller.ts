import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ZodType } from 'zod';
import { ApiKeyGuard, RequireScopes } from '../../auth/api-key.guard';
import type { AuthenticatedRequest } from '../../auth/api-key.types';
import { requestBaseUrl } from '../../auth/resource-metadata';
import { sourcePlaneEnabled, sourceWebhooksEnabled } from '../../common/source-plane-flags';
import {
  WebhookSetupRequestSchema,
  isConnectionId,
  type WebhookSetupResponse,
} from '../../contracts/source-plane/source-plane.schema';
import { RecordsWebhookService } from './records-webhook.service';

/**
 * The operator's side of a connection's inbound webhook (brain:admin):
 * switch it on — the address to register at the vendor, the secret
 * shown once, the vendor's how-to — and off. Same root as the
 * connections controller, one deeper path, so `:id` there never
 * swallows it. 404 while SOURCE_PLANE_ENABLED or SOURCE_WEBHOOKS is off.
 */
@Controller('v1/admin/source-connections')
@UseGuards(ApiKeyGuard)
export class AdminSourceWebhookController {
  constructor(private readonly webhooks: RecordsWebhookService) {}

  @Post(':id/webhook')
  @RequireScopes('brain:admin')
  async setup(
    @Req() req: AuthenticatedRequest & Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<WebhookSetupResponse> {
    assertEnabled();
    const dto = parseBody(WebhookSetupRequestSchema, body ?? {});
    const baseUrl = requestBaseUrl(req);
    if (!baseUrl) {
      throw new BadRequestException('cannot determine the public base URL — set BRAIN_PUBLIC_URL');
    }
    return this.webhooks.setup(req.brainAuth.companyId, {
      connectionId: assertId(id),
      secret: dto.secret,
      baseUrl,
    });
  }

  @Delete(':id/webhook')
  @RequireScopes('brain:admin')
  async disable(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    assertEnabled();
    await this.webhooks.disable(req.brainAuth.companyId, assertId(id));
    return { ok: true };
  }
}

function assertEnabled(): void {
  if (!sourcePlaneEnabled() || !sourceWebhooksEnabled()) throw new NotFoundException();
}

function assertId(id: string): string {
  const full = id.startsWith('source_connection:') ? id : `source_connection:${id}`;
  if (!isConnectionId(full)) throw new BadRequestException('invalid connection id');
  return full;
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      error: 'validation_failed',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
