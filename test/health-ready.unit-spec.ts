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
  function mk(opts: { db: boolean; embedderReady: boolean; scoped?: boolean }) {
    const surreal = {
      ping: async () => opts.db,
      pingScoped: async () => opts.scoped ?? true,
      scopedPoolEnabled: () => true,
    } as any;
    const embedder = {
      isReady: () => opts.embedderReady,
      warmupStatus: () => ({ ready: opts.embedderReady, failures: 0, inFlight: false }),
    } as any;
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
      expect(res.checks.scopedPool).toBe('ok');
      expect(res.checks.embedder).toBe('ok');
    });

    /**
     * Audit 2026-09-08: the scoped pool's session lapsed an hour after boot
     * and every caller-facing read answered "Anonymous access not allowed" —
     * while /ready stayed green, because `ping()` calls `version()`, which
     * SurrealDB answers for an anonymous session too. A readiness probe that
     * cannot see the request path is part of the outage, so /ready now runs
     * an authorization-gated statement on a scoped connection.
     */
    it('throws 503 when the socket is fine but the scoped read path is unauthorized', async () => {
      await expect(
        mk({ db: true, embedderReady: true, scoped: false }).ready(),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('names the scoped pool in the 503 body so the operator sees which leg failed', async () => {
      const err = await mk({ db: true, embedderReady: true, scoped: false })
        .ready()
        .catch((e: ServiceUnavailableException) => e);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        ready: false,
        checks: { surrealdb: 'ok', scopedPool: 'unauthorized', embedder: 'ok' },
      });
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
