/**
 * Unit-test for HealthController. Verifies the liveness/readiness
 * split:
 *   /health  — always answers (used by docker-compose), DB ping
 *              optional.
 *   /ready   — 200 only when DB pings AND the embedder reports ready;
 *              503 otherwise.
 *
 * Closes the Phase 4 audit gap: pre-fix the embedder service awaited
 * BGE-M3 warmup inside onModuleInit, blocking Nest bootstrap and
 * making /health (== /ready) flap on cold boot. Now warmup is fire-
 * and-forget; /ready waits on isReady() instead.
 */
import { HealthController } from '../src/common/health.controller';
import { HealthService } from '../src/common/health.service';
import { ServiceUnavailableException } from '@nestjs/common';

describe('HealthController', () => {
  function mk({
    db,
    embedderReady,
  }: {
    db: boolean;
    embedderReady: boolean;
  }) {
    const surreal = { ping: async () => db } as any;
    const embedder = { isReady: () => embedderReady } as any;
    return new HealthController(new HealthService(surreal, embedder));
  }

  describe('/health', () => {
    it('returns ok when DB pings', async () => {
      const res = await mk({ db: true, embedderReady: false }).health();
      expect(res.status).toBe('ok');
      expect(res.checks.surrealdb).toBe('ok');
    });

    it('returns degraded when DB does not ping', async () => {
      const res = await mk({ db: false, embedderReady: true }).health();
      expect(res.status).toBe('degraded');
      expect(res.checks.surrealdb).toBe('unreachable');
    });

    it('does not depend on embedder warmup state', async () => {
      // /health must answer even when the embedder is still warming —
      // this is the difference vs /ready, and what stops the docker-
      // compose healthcheck from looping the container.
      const res = await mk({ db: true, embedderReady: false }).health();
      expect(res.status).toBe('ok');
    });
  });

  describe('/ready', () => {
    it('returns 200 when DB pings AND embedder reports ready', async () => {
      const res = await mk({ db: true, embedderReady: true }).ready();
      expect(res.ready).toBe(true);
      expect(res.checks.surrealdb).toBe('ok');
      expect(res.checks.embedder).toBe('ok');
    });

    it('throws 503 when embedder is still warming', async () => {
      await expect(mk({ db: true, embedderReady: false }).ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('throws 503 when DB is unreachable', async () => {
      await expect(mk({ db: false, embedderReady: true }).ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
