import {
  IsString,
  IsOptional,
  IsArray,
  IsObject,
  IsISO8601,
} from 'class-validator';

export interface MentionContextRef {
  vertical: string;
  conversationId?: string;
  messageId?: string;
  eventId?: string;
}

export interface KnownEntity {
  vertical: string;
  id: string;
  role?: string;
}

export class IngestMentionDto {
  @IsString()
  text: string;

  @IsObject()
  contextRef: MentionContextRef;

  @IsOptional() @IsArray()
  knownEntities?: KnownEntity[];

  @IsISO8601()
  emittedAt: string;
}
