import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body shape for POST /v1/admin/demo/ingest-mention.
 *
 * Pre-fix the controller accepted a plain inline TS type, which
 * silently slipped past the global ValidationPipe's
 * forbidNonWhitelisted: true — arbitrary extra fields rode through.
 * Promoting to a class-validator DTO restores the whitelist + the
 * @MaxLength cap that the public /v1/ingest/mention DTO already has.
 */
export class DemoIngestMentionDto {
  @IsString()
  @MaxLength(16_000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  vertical?: string;
}
