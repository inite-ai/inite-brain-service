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
  // Provenance of the recorder that produced this mention. Flows into the
  // fact `source.recorder`, which keys source-trust via fn::source_key_of
  // (`vertical:recorder`). When omitted, the ingest path defaults it to the
  // extraction model id so LLM-extracted facts get a per-model trust bucket
  // instead of collapsing to the recorder-less `vertical:_`.
  recorder?: string;
}

export interface KnownEntity {
  vertical: string;
  id: string;
  /**
   * Participant role in this turn. `speaker` = who is talking (first-person
   * "I/me/my" resolves here); `addressee` = who they address (second-person
   * "you/your" resolves here). Absent = a plain entity anchor with no
   * coreference role.
   */
  role?: string;
  /**
   * Display name of the participant, when known. Lets the ingest path
   * resolve a third-person self-mention ("Caroline said …" spoken BY
   * Caroline) to the same entity as the first-person path, and lets the
   * extractor be told who is speaking. Optional — absent falls back to
   * pronoun-only coreference.
   */
  name?: string;
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
