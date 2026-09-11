import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Move. Both ends go through the path fence; a bad destination is a 400. */
export class MemoryFileRenameDto {
  @IsString()
  @MaxLength(512)
  path!: string;

  @IsString()
  @MaxLength(512)
  newPath!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string | undefined;
}
