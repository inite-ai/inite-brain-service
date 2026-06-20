import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DemoChatDto {
  @IsString()
  @MaxLength(8_000)
  message!: string;

  @IsOptional()
  includePii?: boolean;
}
