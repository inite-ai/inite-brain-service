import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The body every path-addressed route takes — read and delete both.
 *
 * Paths travel in the BODY, not the URL, on reads too: they carry
 * slashes, and `/memories/a%2Fb` vs `/memories/a/b` disagreeing about
 * identity is an access-control question when the row fence is keyed on
 * (path, userId).
 *
 * Shape checks only. The path RULES — must start with /memories, no
 * traversal — live in normalizeMemoryPath, next to the fence they are.
 */
export class MemoryFileReadDto {
  @IsString()
  @MaxLength(512)
  path!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string | undefined;
}
