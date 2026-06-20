import { IsArray, IsIn, IsOptional } from 'class-validator';

export class DemoDreamsDto {
  @IsOptional()
  @IsArray()
  @IsIn(['dedup', 'resolve'], { each: true })
  operations?: ('dedup' | 'resolve')[];
}
