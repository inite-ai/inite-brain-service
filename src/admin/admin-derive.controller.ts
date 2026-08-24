import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import {
  WindowDeriverService,
  DeriveRunResult,
  WINDOW_DERIVER_VERSION,
} from './window-deriver.service';

/**
 * A derive where every attempted conversation failed produced nothing:
 * answering 201 would hand the caller a hollow world (the V2 incident —
 * an OpenAI 429 became 18 poisoned eval rows). 502 says "upstream broke,
 * nothing was derived, retry when it recovers". Partial failures still
 * return the result — callers must check `status`/`failed`.
 */
export function throwIfDeriveFailed(result: DeriveRunResult): DeriveRunResult {
  if (result.status === 'failed') {
    throw new BadGatewayException({
      message:
        `derive failed: 0 of ${result.failed} conversation(s) derived — ` +
        `first reason: ${result.skipped[0]?.reason}`,
      status: result.status,
      failed: result.failed,
      skipped: result.skipped.slice(0, 10),
    });
  }
  return result;
}

/**
 * Explicit trigger for the session-window batch deriver (P3 v1). One LLM
 * call per session over the L0 substrate — a paid, operator-invoked
 * batch, never ambient. Re-runs replace the version's facts per
 * conversation (delete-by-version), so the endpoint is idempotent. Flip
 * the read world afterwards with RETRIEVAL_DERIVED_VERSION.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminDeriveController {
  constructor(
    private readonly deriver: WindowDeriverService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/derive')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      tenant?: string;
      version?: string;
      conversation?: string;
      /** Flip the live read pin to this version after a successful run. */
      activate?: boolean;
      /** Allow rewriting the currently pinned world in place (eval only). */
      force?: boolean;
    } = {},
  ): Promise<DeriveRunResult> {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    const version = body.version?.trim() || WINDOW_DERIVER_VERSION;
    if (!/^[a-z0-9-]{2,32}$/.test(version)) {
      throw new BadRequestException('version must be a short kebab-case tag (e.g. wd-v2)');
    }
    const conversationId = body.conversation?.trim() || undefined;
    if (conversationId && conversationId.length > 128) {
      throw new BadRequestException('conversation id too long');
    }
    try {
      return throwIfDeriveFailed(
        await this.deriver.run(tenant, {
          version,
          conversationId,
          activate: body.activate === true,
          force: body.force === true,
        }),
      );
    } catch (e) {
      // The live-pin guard is a caller mistake, not a server fault.
      if ((e as Error).message.includes('live read pin')) {
        throw new BadRequestException((e as Error).message);
      }
      // Derive lease conflict (audit 2026-08-19 P1): another run holds
      // the (tenant, version) — 409, retry after it finishes.
      if ((e as Error).message.includes('derive already in flight')) {
        throw new ConflictException((e as Error).message);
      }
      throw e;
    }
  }

  /**
   * Reap residual derived worlds (forks that are no longer the live pin
   * and not explicitly kept). Legacy facts are never touched.
   */
  @Post('maintenance/derive/gc')
  @RequireScopes('brain:admin')
  async gc(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; keep?: string[] } = {},
  ): Promise<{ deleted: Record<string, number>; kept: string[] }> {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    const keep = (body.keep ?? []).filter(
      (v) => typeof v === 'string' && /^[a-z0-9-]{2,32}$/.test(v),
    );
    return this.deriver.gc(tenant, { keep });
  }
}
