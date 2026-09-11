import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Directory listing. An absent prefix means the whole `/memories` root. */
export class MemoryFileListDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  prefix?: string | undefined;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string | undefined;
}
