import { SearchDto, SearchMode } from './dto/search.dto';
import type { DomainSignal } from '../ai/domain-routing.service';

/**
 * Per-request retrieval-pipeline context, shared by the search
 * orchestrator and its stage services (retrieval / rerank). Built once
 * by SearchService.search() from the public SearchDto.
 */
export interface PipelineContext {
  dto: SearchDto;
  callerScopes: string[];
  /** Tenant id — the ABAC meta-union pass resolves origin docs by it. */
  companyId: string;
  limit: number;
  asOf: Date | null;
  includeRetracted: boolean;
  includeContested: boolean;
  mode: SearchMode;
  candidateK: number;
  /**
   * Domain-routed retrieval signal (SEARCH_DOMAIN_ROUTING_ENABLED),
   * computed once per request before the scoped-pool section — feeds the
   * router vocabulary, the scoring-stage domain boost, and (filter mode)
   * candidate narrowing. Null/absent → pipeline behaves exactly as before.
   */
  domainSignal?: DomainSignal | null;
}
