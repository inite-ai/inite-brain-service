import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ISSUABLE_SCOPES } from '../issuable-scopes';

export class IssueKeyDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(ISSUABLE_SCOPES, { each: true })
  scopes!: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  userId?: string;
}
