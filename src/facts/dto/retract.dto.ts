import { IsString, IsObject } from 'class-validator';

export interface RetractedBy {
  userId?: string;
  source: 'human' | 'system';
}

export class RetractFactDto {
  @IsString()
  reason: string;

  @IsObject()
  retractedBy: RetractedBy;
}
