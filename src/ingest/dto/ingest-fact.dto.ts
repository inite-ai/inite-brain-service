import {
  IsBoolean,
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsISO8601,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  @MaxLength(256)
  predicate: string;

  // Object is a single fact value (price, address, name…); 2 KB covers
  // any realistic structured value. Anything longer is almost certainly
  // a misuse of the fact model — open prose belongs in mention text.
  @IsString()
  @MaxLength(2_000)
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

  /**
   * Emit a `conflictExplanation` alongside the outcome when the new
   * fact lands in SUPERSEDED or COMPETING. Off by default to keep the
   * response shape stable. Has no effect for INSERTED / REJECTED
   * outcomes (no opponent to compare against).
   *
   * See `conflict-explainer.ts` for the shape and the deterministic
   * narrative template.
   */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  explain?: boolean;
}
