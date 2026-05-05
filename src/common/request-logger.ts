import { Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

const log = new Logger('Request');

/**
 * One structured line per request, written when the response is finished.
 * Includes status, durationMs, and (when authenticated) companyId + a
 * short hash prefix to correlate calls without leaking the key.
 *
 * /health is filtered out — it's hit by load balancers every few seconds
 * and would drown out useful traffic.
 */
export function requestLogger() {
  return function (req: Request, res: Response, next: NextFunction) {
    if (req.path === '/health') return next();

    const start = process.hrtime.bigint();
    const onDone = () => {
      res.removeListener('finish', onDone);
      res.removeListener('close', onDone);

      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const auth = (req as unknown as {
        brainAuth?: { companyId: string; keyHash: string };
      }).brainAuth;
      const companyId = auth?.companyId ?? '-';
      const keyTag = auth?.keyHash ? auth.keyHash.slice(7, 15) : '-';

      log.log(
        `${req.method} ${req.originalUrl ?? req.url} → ${res.statusCode} ` +
          `${durationMs.toFixed(1)}ms company=${companyId} key=${keyTag}`,
      );
    };
    res.once('finish', onDone);
    res.once('close', onDone);
    next();
  };
}
