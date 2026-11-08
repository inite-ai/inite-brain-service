import { IsString, MaxLength } from 'class-validator';

/** A demo visitor's question. Short on purpose: it is a question, not a document. */
export class DemoWorkspaceChatDto {
  @IsString()
  @MaxLength(500)
  message!: string;
}
