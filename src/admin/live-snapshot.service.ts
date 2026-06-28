import { Injectable } from '@nestjs/common';
import { ActivityTrackerService } from '../common/activity-tracker.service';
import { ThrottlerObservabilityService } from './throttler-observability.service';
import type { ThrottlerResponse } from '../contracts/admin/throttler.schema';
import type { NowResponse } from '../contracts/admin/now.schema';

/**
 * LiveSnapshotService — live operational snapshots for the admin cockpit:
 * the throttler observability view (/v1/admin/throttler) and the
 * in-flight HTTP request list (/v1/admin/now). Extracted from
 * AdminInfraController so the controller keeps ≤3 deps.
 */
@Injectable()
export class LiveSnapshotService {
  constructor(
    private readonly throttler: ThrottlerObservabilityService,
    private readonly activity: ActivityTrackerService,
  ) {}

  throttlerSnapshot(): ThrottlerResponse {
    return this.throttler.snapshot() satisfies ThrottlerResponse;
  }

  now(): NowResponse {
    return {
      generatedAt: new Date().toISOString(),
      inFlight: this.activity.list(),
    } satisfies NowResponse;
  }
}
