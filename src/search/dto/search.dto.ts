import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsIn,
  Min,
  Max,
} from 'class-validator';

export type SearchMode = 'vector' | 'lexical' | 'hybrid';

export class SearchDto {
  @IsString()
  query: string;

  @IsOptional() @IsNumber() @Min(1) @Max(100)
  limit?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  entityTypes?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  predicates?: string[];

  @IsOptional() @IsISO8601()
  asOf?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  minConfidence?: number;

  @IsOptional() @IsBoolean()
  includeContested?: boolean;

  @IsOptional() @IsBoolean()
  includeRetracted?: boolean;

  /**
   * Retrieval strategy. `hybrid` (default) runs vector + BM25 in
   * parallel and fuses via reciprocal-rank fusion. `vector` is
   * embedding-only — best for paraphrastic / cross-lingual queries.
   * `lexical` is BM25-only — useful when callers want exact-token
   * matching (id lookups, regulatory queries) without semantic drift.
   */
  @IsOptional() @IsIn(['vector', 'lexical', 'hybrid'])
  searchMode?: SearchMode;
}
