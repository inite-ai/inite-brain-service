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
}
