import {
  IsString,
  IsOptional,
  IsArray,
  IsISO8601,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MentionContextRefDto {
  @IsString()
  vertical: string;

  @IsOptional() @IsString() conversationId?: string;
  @IsOptional() @IsString() messageId?: string;
  @IsOptional() @IsString() eventId?: string;
}

export class KnownEntityDto {
  @IsString() vertical: string;
  @IsString() id: string;
  @IsOptional() @IsString() role?: string;
}

export class IngestMentionDto {
  @IsString()
  text: string;

  @ValidateNested()
  @Type(() => MentionContextRefDto)
  contextRef: MentionContextRefDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KnownEntityDto)
  knownEntities?: KnownEntityDto[];

  @IsISO8601()
  emittedAt: string;
}
