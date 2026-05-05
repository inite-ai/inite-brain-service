import {
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LinkRefByVerticalDto {
  @IsString() vertical: string;
  @IsString() id: string;
}

export class LinkRefByIdDto {
  @IsString() entityId: string;
}

export class LinkSourceDto {
  @IsString() vertical: string;
  @IsOptional() @IsString() eventId?: string;
}

export class IngestLinkDto {
  @ValidateNested()
  @Type(() => Object)
  from: LinkRefByVerticalDto | LinkRefByIdDto;

  @ValidateNested()
  @Type(() => Object)
  to: LinkRefByVerticalDto | LinkRefByIdDto;

  @IsString()
  kind: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  weight?: number;

  @ValidateNested()
  @Type(() => LinkSourceDto)
  source: LinkSourceDto;
}
