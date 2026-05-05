import {
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export interface LinkRef {
  vertical?: string;
  id?: string;
  entityId?: string;
}

export interface LinkSource {
  vertical: string;
  eventId?: string;
}

export class IngestLinkDto {
  @IsObject()
  from: LinkRef;

  @IsObject()
  to: LinkRef;

  @IsString()
  kind: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  weight?: number;

  @IsObject()
  source: LinkSource;
}
