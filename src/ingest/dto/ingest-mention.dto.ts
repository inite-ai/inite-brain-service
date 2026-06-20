import {
  IsString,
  IsOptional,
  IsArray,
  IsObject,
  IsISO8601,
  MaxLength,
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
  // Hard ceiling on mention text. A 16 000-char mention chunks to
  // ~4 000 tokens for the extractor — well above any realistic chat
  // message or doc paragraph, but small enough that a malicious 1 MB
  // payload can't blow the OpenAI bill. Service-side truncation in
  // ExtractorService is the defence-in-depth backstop.
  @IsString()
  @MaxLength(16_000)
  text: string;

  @IsObject()
  contextRef: MentionContextRef;

  @IsOptional() @IsArray()
  knownEntities?: KnownEntity[];

  @IsISO8601()
  emittedAt: string;
}
