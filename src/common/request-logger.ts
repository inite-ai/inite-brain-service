import { Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { getCorrelationId } from './request-context';
import { PROCESS_IDENTITY } from './process-identity';

const log = new Logger('Request');

/**
 * One structured line per request, written when the response is finished.
 * Includes status, durationMs, and (when authenticated) companyId + a
 * short hash prefix to correlate calls without leaking the key.
 *
 * Format selection:
 *   - LOG_FORMAT=json (or NODE_ENV=production) → one JSON object per line,
 *     friendly for log shippers (Loki, CloudWatch, Datadog).
 *   - otherwise → human-readable single-line text, friendly for `tail -f`.
 *
 * /health, /ready and /metrics are filtered out — all three get hit on a
 * tight cadence by infrastructure (Traefik's load-balancer healthcheck
 * polls /ready every 3s per replica, the prom-scraper /metrics every 15s)
 * and would drown out useful traffic. Readiness flips are visible on
 * `brain_capability_probe_*` and in the boot log, not here.
 */
const SKIP_PATHS = new Set(['/health', '/ready', '/metrics']);

function useJson(): boolean {
  if (process.env.LOG_FORMAT === 'json') return true;
  if (process.env.LOG_FORMAT === 'text') return false;
  return process.env.NODE_ENV === 'production';
}

export function requestLogger() {
  const json = useJson();
  return function (req: Request, res: Response, next: NextFunction) {
    if (SKIP_PATHS.has(req.path)) return next();

    const start = process.hrtime.bigint();
    const onDone = () => {
      res.removeListener('finish', onDone);
      res.removeListener('close', onDone);

      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const auth = (
        req as unknown as {
          brainAuth?: { companyId: string; keyHash: string };
        }
      ).brainAuth;
      const companyId = auth?.companyId ?? '-';
      const keyTag = auth?.keyHash ? auth.keyHash.slice(7, 15) : '-';
      const url = req.originalUrl ?? req.url;
      const requestId = getCorrelationId() ?? '-';

      if (json) {
        process.stdout.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            kind: 'request',
            // Which replica served it. Loki keeps one stream per
            // container, but a line read on its own (or after a
            // `| json` across replicas) is otherwise anonymous.
            instance: PROCESS_IDENTITY,
            requestId,
            method: req.method,
            path: url,
            status: res.statusCode,
            durationMs: Number(durationMs.toFixed(1)),
            companyId,
            keyTag,
          }) + '\n',
        );
      } else {
        log.log(
          `[${requestId}] ${req.method} ${url} → ${res.statusCode} ` +
            `${durationMs.toFixed(1)}ms company=${companyId} key=${keyTag}`,
        );
      }
    };
    res.once('finish', onDone);
    res.once('close', onDone);
    next();
  };
}
