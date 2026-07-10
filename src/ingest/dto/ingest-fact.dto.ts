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

/**
 * One supporting observation behind a fact — a typed pointer to where the
 * claim came from (an event row, a message, a URL, a document, a commit…).
 * Stored verbatim inside `knowledge_fact.source` (FLEXIBLE), so it needs
 * no migration and survives round-trips. Shape-checked in
 * FactIngestService (see evidenceValidationError in ingest-utils.ts) —
 * class-validator can't nest into the opaque source object.
 */
export interface SourceEvidence {
  kind:
    | 'event'
    | 'message'
    | 'conversation'
    | 'url'
    | 'document'
    | 'commit'
    | 'other';
  /** The pointer itself — id, URL, path, sha… ≤512 chars. */
  ref: string;
  note?: string;
}

export interface FactSource {
  vertical: string;
  eventId?: string;
  conversationId?: string;
  messageId?: string;
  recorder?: string;
  /** Supporting observations behind the claim — ≤10 entries. */
  evidence?: SourceEvidence[];
  // NOTE: `originKey` (corroboration origin identity, migration 0050) is
  // NOT part of this contract. It is stamped only by the content-addressed
  // document/commit path; FactIngestService strips any client-supplied
  // value before resolving. See the strip in fact-ingest.service.ts.
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

  /**
   * Per-user scope (migration 0055). Stamps the fact — and, for a
   * vertical+id entityRef, the entity dedup key — with this end-user:
   * invisible to every other user of the tenant and to requests that
   * don't assert a userId (fail-closed reads). A bare entityId ref
   * attaches the personal fact to that entity whatever its scope.
   * Conflict resolution is scope-local: a user's fact never
   * supersedes, competes with, or corroborates the tenant-global
   * timeline. The caller — a trusted backend holding the tenant key —
   * asserts the user.
   */
  @IsOptional() @IsString() @MaxLength(200)
  userId?: string;

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
