import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { FeedbackService } from './feedback.service';
import { RecordFeedbackDto } from './dto/record-feedback.dto';

@Controller('v1/feedback')
@UseGuards(ApiKeyGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  // actor = the caller's key hash: stable per credential, never
  // free-form, so the one-vote-per-(fact, actor) fence can't be dodged
  // by self-reported identities.
  @Post()
  @RequireScopes('brain:write')
  async record(
    @Req() req: AuthenticatedRequest,
    @Body() body: RecordFeedbackDto,
  ) {
    return this.feedback.record({
      companyId: req.brainAuth.companyId,
      factId: body.factId,
      verdict: body.verdict,
      reason: body.reason,
      actor: req.brainAuth.keyHash,
    });
  }
}
