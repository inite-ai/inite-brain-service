import { SearchDto, SearchMode } from './dto/search.dto';

/**
 * Per-request retrieval-pipeline context, shared by the search
 * orchestrator and its stage services (retrieval / rerank). Built once
 * by SearchService.search() from the public SearchDto.
 */
export interface PipelineContext {
  dto: SearchDto;
  callerScopes: string[];
  limit: number;
  asOf: Date | null;
  includeRetracted: boolean;
  includeContested: boolean;
  mode: SearchMode;
  candidateK: number;
}
