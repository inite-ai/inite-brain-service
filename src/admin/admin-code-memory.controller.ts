import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { CodeMemoryAnchorService } from '../code-memory/code-memory-anchor.service';
import type {
  AnchorsListResponse,
  AnchorVerdict,
  ApplyVerdictsResponse,
} from '../contracts/admin/code-memory.schema';

/**
 * Server side of the code-memory anchor re-validation sweep (Phase 2b). The
 * client lists anchors, checks each against the working tree, and POSTs
 * verdicts; the server applies reanchor / invalidate. brain:admin.
 */
@Controller('v1/admin/code-memory')
@UseGuards(ApiKeyGuard)
export class AdminCodeMemoryController {
  constructor(private readonly anchors: CodeMemoryAnchorService) {}

  @Get('anchors')
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest): Promise<AnchorsListResponse> {
    const anchors = await this.anchors.listAnchors(req.brainAuth.companyId, req.brainAuth.scopes);
    return { anchors } satisfies AnchorsListResponse;
  }

  @Post('anchors/apply')
  @RequireScopes('brain:admin')
  async apply(
    @Req() req: AuthenticatedRequest,
    @Body() body: { verdicts: AnchorVerdict[] },
  ): Promise<ApplyVerdictsResponse> {
    const companyId = req.brainAuth.companyId;
    const out: ApplyVerdictsResponse = {
      reanchored: 0,
      invalidated: 0,
      factsRetracted: 0,
      skipped: 0,
    };
    for (const v of body?.verdicts ?? []) {
      if (v.action === 'reanchor') {
        const r = await this.anchors.reanchor(companyId, v.anchor, v.newAnchor);
        if (r.reanchored) out.reanchored += 1;
        else out.skipped += 1;
      } else if (v.action === 'invalidate') {
        const n = await this.anchors.invalidateAnchor(
          companyId,
          v.anchor,
          v.reason ?? 'anchor stale',
        );
        out.invalidated += 1;
        out.factsRetracted += n;
      } else {
        out.skipped += 1;
      }
    }
    return out;
  }
}
