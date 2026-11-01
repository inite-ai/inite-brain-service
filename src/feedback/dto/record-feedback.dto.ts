import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { FeedbackVerdict } from '../feedback.service';

export class RecordFeedbackDto {
  @IsString()
  factId!: string;

  @IsIn(['helpful', 'not_helpful', 'incorrect'])
  verdict!: FeedbackVerdict;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  /**
   * The user the caller acts for. A personal fact is visible, and so
   * rateable, only for its own user; a user-bound key is pinned to its own.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string;
}
