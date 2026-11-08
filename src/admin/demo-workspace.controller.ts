import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { envFlagEnabled } from '../common/env-validation';
import { DEMO_ORG_ID } from '../demo/demo-tenant';
import { DemoChatService } from './demo-chat.service';
import { rethrowDemoChatError } from './demo-upstream-guard';
import { DemoWorkspaceService } from './demo-workspace.service';
import { DemoWorkspaceChatDto } from './dto/demo-workspace-chat.dto';

/** Off unless BRAIN_DEMO_WORKSPACE_ENABLED=1: an absent route, a 404. */
export function demoWorkspaceEnabled(): boolean {
  return envFlagEnabled(process.env.BRAIN_DEMO_WORKSPACE_ENABLED);
}

/**
 * The public demo workspace: Ana's workspace at «Atlântica Group (demo)»,
 * the family's one demo tenant (src/demo/demo-tenant.ts). brain.inite.ai's
 * landing serves it to a visitor signed in through `/api/auth/demo`, over
 * its own service credential (brain-landing `/api/app/demo`).
 *
 * What makes it safe to read from any `brain:read` caller:
 *   - it reads ONE tenant, fixed in code: DEMO_ORG_ID, whose every row is
 *     made up (src/demo/atlantica-pack.ts). The caller's own tenant is
 *     neither read nor written; no request field picks the tenant;
 *   - it has no write route. Chat is `DemoChatService.askReadOnly`: the
 *     router's local pre-pass only, always an ask, graph retrieval only.
 *     No ingest, no record_fact, no dedup, no model call — so no tokens to
 *     burn either;
 *   - reads run under `brain:read` alone: PII predicates stay redacted.
 *
 * No `expensive` throttle: nothing here calls a model, and every demo
 * visitor arrives over the landing's one credential (the landing holds the
 * per-visitor bucket). The default per-credential throttle still applies.
 * Chat errors go through the same upstream guard as the operator demo.
 */
@Controller('v1/demo/workspace')
@UseGuards(ApiKeyGuard)
export class DemoWorkspaceController {
  private readonly logger = new Logger(DemoWorkspaceController.name);

  constructor(
    private readonly workspace: DemoWorkspaceService,
    private readonly chatService: DemoChatService,
  ) {}

  @Get('graph')
  @RequireScopes('brain:read')
  async graph() {
    if (!demoWorkspaceEnabled()) throw new NotFoundException();
    return this.workspace.graph();
  }

  @Post('chat')
  @HttpCode(200)
  @RequireScopes('brain:read')
  async chat(@Body() body: DemoWorkspaceChatDto) {
    if (!demoWorkspaceEnabled()) throw new NotFoundException();
    const message = body?.message?.trim();
    if (!message) throw new BadRequestException('message is required');
    try {
      const result = await this.chatService.askReadOnly({
        message,
        tenant: DEMO_ORG_ID,
        scopes: ['brain:read'],
      });
      return {
        strategy: result.strategy,
        mentions: result.route.mentions.map((m) => m.canonical),
        asOf: result.route.asOf?.iso ?? null,
        results: result.search.results,
      };
    } catch (err) {
      rethrowDemoChatError(err, this.logger, '/v1/demo/workspace/chat');
    }
  }
}
