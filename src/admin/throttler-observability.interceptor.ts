import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { ThrottlerObservabilityService } from './throttler-observability.service';
import type { AuthenticatedRequest } from '../auth/api-key.types';

/**
 * Records every HTTP response (route + actor + 429-or-not) into the
 * ThrottlerObservabilityService so the admin UI can chart top-talkers
 * and recent rejections.
 *
 * Auth/health/SSE paths are excluded — they're noise for throttler
 * analysis.
 */
@Injectable()
export class ThrottlerObservabilityInterceptor implements NestInterceptor {
  constructor(
    private readonly observability: ThrottlerObservabilityService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & Partial<AuthenticatedRequest>>();
    const res = http.getResponse<Response>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (
      path === '/health' ||
      path === '/ready' ||
      path === '/metrics' ||
      path.endsWith('/stream')
    ) {
      return next.handle();
    }
    return next.handle().pipe(
      tap({
        next: () =>
          this.observability.record(
            this.buildInput({ req, res, path, forceThrottled: false }),
          ),
        error: (err) =>
          this.observability.record(
            this.buildInput({
              req,
              res,
              path,
              forceThrottled: err?.status === 429,
            }),
          ),
      }),
    );
  }

  private buildInput({
    req,
    res,
    path,
    forceThrottled,
  }: {
    req: Request & Partial<AuthenticatedRequest>;
    res: Response;
    path: string;
    forceThrottled: boolean;
  }): {
    actor: string;
    method: string;
    path: string;
    status: number;
    throttled: boolean;
  } {
    return {
      actor: req.brainAuth?.companyId ?? 'anon',
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      status: res.statusCode ?? 0,
      throttled: forceThrottled || res.statusCode === 429,
    };
  }
}
