import { Injectable } from '@nestjs/common';

export interface InFlightRequest {
  id: string;
  method: string;
  path: string;
  companyId?: string | undefined;
  startedAtMs: number;
}

/**
 * Tracks currently-open HTTP requests. Updated by the
 * InFlightInterceptor; read by /v1/admin/now.
 *
 * Pure in-process; capped at 256 concurrent (anything past that
 * silently drops — we never want this map to grow past O(1) memory).
 */
@Injectable()
export class ActivityTrackerService {
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly capacity = 256;

  add(req: InFlightRequest): void {
    if (this.inFlight.size >= this.capacity) return;
    this.inFlight.set(req.id, req);
  }

  remove(id: string): void {
    this.inFlight.delete(id);
  }

  list(): InFlightRequest[] {
    return [...this.inFlight.values()].sort(
      (a, b) => a.startedAtMs - b.startedAtMs,
    );
  }
}
