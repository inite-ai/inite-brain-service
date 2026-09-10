import { hostname } from 'node:os';
import type { Request, Response } from 'express';
import { PROCESS_IDENTITY } from '../src/common/process-identity';
import { requestLogger } from '../src/common/request-logger';

/**
 * One identity across metrics, logs and traces. Correlating a metric spike
 * with the log lines and the traces from the SAME replica only works if
 * all three name it the same way — so this pins that the log line carries
 * the identifier and that the value is the one the other two use.
 */
describe('per-replica identity', () => {
  it('starts from the OS hostname, which Docker sets to the container id', () => {
    expect(PROCESS_IDENTITY.startsWith(`${hostname()}#${process.pid}#`)).toBe(true);
  });
});

describe('the JSON request line', () => {
  function logOne(path: string): string[] {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const saved = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    try {
      const finish: Array<() => void> = [];
      const req = { path, method: 'POST', originalUrl: path } as unknown as Request;
      const res = {
        statusCode: 200,
        once: (event: string, cb: () => void) => {
          if (event === 'finish') finish.push(cb);
        },
        removeListener: () => undefined,
      } as unknown as Response;
      requestLogger()(req, res, () => undefined);
      for (const cb of finish) cb();
      return written;
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.LOG_FORMAT;
      else process.env.LOG_FORMAT = saved;
    }
  }

  it('says which replica served the request', () => {
    const [line] = logOne('/v1/search');
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({
      kind: 'request',
      instance: PROCESS_IDENTITY,
      path: '/v1/search',
    });
  });

  it('does not log the load balancer’s readiness poll', () => {
    // Traefik polls /ready every 3s per replica; logging it would drown
    // real traffic in the same way /health and /metrics already did.
    expect(logOne('/ready')).toEqual([]);
    expect(logOne('/health')).toEqual([]);
    expect(logOne('/metrics')).toEqual([]);
  });
});
