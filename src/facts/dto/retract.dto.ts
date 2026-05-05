import { IsString, IsOptional, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class RetractedByDto {
  @IsOptional() @IsString() userId?: string;

  @IsString() @IsIn(['human', 'system'])
  source: 'human' | 'system';
}

export class RetractFactDto {
  @IsString()
  reason: string;

  @ValidateNested()
  @Type(() => RetractedByDto)
  retractedBy: RetractedByDto;
}
