import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Create or replace. Content is stored verbatim — see MemoryFileService. */
export class MemoryFileWriteDto {
  @IsString()
  @MaxLength(512)
  path!: string;

  // The service applies the same ceiling and answers with a clear
  // message; this one stops a 10 MB body from being parsed at all.
  @IsString()
  @MaxLength(100_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string | undefined;
}
