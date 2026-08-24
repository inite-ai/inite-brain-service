import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, finalize } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { ActivityTrackerService } from './activity-tracker.service';
import type { AuthenticatedRequest } from '../auth/api-key.types';

/**
 * Records currently-open HTTP requests so the /admin/now panel can
 * show "right now we are serving these requests, with this elapsed".
 * Removes entries on terminal (success or error) via finalize().
 */
@Injectable()
export class InFlightInterceptor implements NestInterceptor {
  constructor(private readonly tracker: ActivityTrackerService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & Partial<AuthenticatedRequest>>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    // SSE handlers stay open by design — recording them as "in flight"
    // would make every connected admin browser look like a stuck request.
    if (path.endsWith('/stream')) return next.handle();
    const id = randomUUID();
    this.tracker.add({
      id,
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      companyId: req.brainAuth?.companyId,
      startedAtMs: Date.now(),
    });
    return next.handle().pipe(finalize(() => this.tracker.remove(id)));
  }
}
