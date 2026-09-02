import { withSpan } from '../common/tracing';
import { getAbortSignal } from '../common/request-context';
import type { SearchService, SearchHit } from '../search/search.service';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { SynthesizeDto } from './dto/synthesize.dto';
import { laneProbeDto, type LaneId } from './answer-router';
import { buildSecondaryDto } from './synthesize.helpers';

/**
 * Deterministic second retrievals per lane, split out of
 * synthesize.service.ts (file-size gate) at the callVerifier seam shape:
 * the orchestrator supplies its search client + logger, this module owns
 * the probe. T4 preference: the fixed tastes probe (recommendation
 * queries rarely surface stored tastes by similarity). T6/T2 wide probe
 * (flag-gated): PRF query built from the base hits — recall breadth for
 * summary/enumeration questions. Degrades to [] on failure; other lanes
 * probe nothing. Audit 2026-08-19 P1: the probe inherits the caller's
 * full filter contract; the lane supplies only its query and limit.
 */
export async function runLaneProbe(
  deps: {
    search: Pick<SearchService, 'search'>;
    logger: { warn(message: string): void };
  },
  opts: {
    profile: RetrievalProfile;
    lane: LaneId | null;
    dto: SynthesizeDto;
    companyId: string;
    callerScopes: string[];
    baseHits: SearchHit[];
  },
): Promise<SearchHit[]> {
  const { profile, lane, dto, companyId, callerScopes, baseHits } = opts;
  const probeDto = laneProbeDto(profile, lane, { query: dto.query, baseHits });
  if (!probeDto || getAbortSignal()?.aborted) return [];
  try {
    const probe = await withSpan('synthesize.lane_probe', () =>
      deps.search.search(companyId, buildSecondaryDto(dto, probeDto), callerScopes),
    );
    return probe.results;
  } catch (e) {
    deps.logger.warn(
      `lane probe failed (lane=${lane}, companyId=${companyId}): ${(e as Error).message}`,
    );
    return [];
  }
}
