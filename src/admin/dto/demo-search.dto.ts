import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DemoSearchDto {
  @IsString()
  @MaxLength(8_000)
  query!: string;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsString()
  asOf?: string;

  @IsOptional()
  includePii?: boolean;
}
