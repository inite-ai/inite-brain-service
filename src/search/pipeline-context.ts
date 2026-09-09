import { SearchDto, SearchMode } from './dto/search.dto';
import type { RetrievalProfile, SearchTuning } from './retrieval-profile';
import type { QueryTimeRange } from './internals/scoring';
import type { ReadPin } from '../episodes/read-pin.service';

/**
 * A retrieval stage that could not run and was skipped rather than failing
 * the whole request. Reported to the caller on the response so a
 * lexical-only answer during an embedder outage is not mistaken for the
 * full ranking.
 */
export type SearchDegradation = 'vector_leg';

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
   * Derived world(s) this request reads, resolved per tenant from the
   * projection registry (audit W2 #9). null → legacy namespace; an
   * array → the multiworld READ union (§10).
   */
  derivedVersion: ReadPin;
  /** Per-tenant retrieval profile, resolved once by the guard. */
  profile: RetrievalProfile;
  /**
   * Deployment-wide tuning knobs, resolved once per request by the
   * retrieval-profile bootstrap (S5.2 — the one module allowed to read
   * the environment under the boundary).
   */
  tuning: SearchTuning;
  /**
   * V13 time filter: the absolute period the query names, parsed once
   * per request when profile.timeFilter is on (internals/time-range).
   * Null/absent → every scoring factor is exactly 1.0.
   */
  queryRange?: QueryTimeRange | null;
  /**
   * Stages skipped on this request (see SearchDegradation). A Set so the
   * shallow copies the orchestrator makes for follow-up passes (entity
   * expansion, lang-filter backoff) share it by reference.
   */
  degraded?: Set<SearchDegradation>;
}
