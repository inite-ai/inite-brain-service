import {
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsISO8601,
  Min,
  Max,
} from 'class-validator';

/**
 * EntityRef and FactSource are unions / open shapes — class-validator's
 * @ValidateNested combined with the global `forbidNonWhitelisted: true`
 * pipe strips union members. We accept them as opaque objects and let
 * the service do shape checks.
 */

export interface EntityRef {
  vertical?: string;
  id?: string;
  entityId?: string;
}

export interface FactSource {
  vertical: string;
  eventId?: string;
  conversationId?: string;
  messageId?: string;
  recorder?: string;
}

export class IngestFactDto {
  @IsObject()
  entityRef: EntityRef;

  @IsString()
  predicate: string;

  @IsString()
  object: string;

  @IsISO8601()
  validFrom: string;

  @IsOptional() @IsISO8601() validUntil?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  confidence?: number;

  @IsObject()
  source: FactSource;

  @IsOptional() @IsObject()
  metadata?: Record<string, unknown>;
}
