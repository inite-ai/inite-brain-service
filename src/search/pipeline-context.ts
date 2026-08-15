import { SearchDto, SearchMode } from './dto/search.dto';
import type { RetrievalProfile, SearchTuning } from './retrieval-profile';

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
   * Derived world this request reads, resolved per tenant from the
   * projection registry (audit W2 #9). null → legacy namespace.
   */
  derivedVersion: string | null;
  /** Per-tenant retrieval profile, resolved once by the guard. */
  profile: RetrievalProfile;
  /**
   * Deployment-wide tuning knobs, resolved once per request by the
   * retrieval-profile bootstrap (S5.2 — the one module allowed to read
   * the environment under the boundary).
   */
  tuning: SearchTuning;
}
