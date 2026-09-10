/**
 * The probes must not be rate limited.
 *
 * Production evidence: Traefik health-checks `/ready` every 3s from its
 * own IP; anonymous requests are tracked by IP, so the probe shares one
 * bucket with every anonymous caller in the world. The bucket filled,
 * the probe got 429, the edge pulled the only replica out of rotation,
 * and every request came back 503 from a service answering 200 inside
 * the container.
 */
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { HealthController } from '../src/common/health.controller';

describe('health probes and the throttler', () => {
  it('exempts the whole controller, so liveness and readiness both answer under load', () => {
    // One metadata key per named throttler. BOTH must be exempt: Nest
    // applies every configured bucket to every route, and `expensive`
    // (10/min) is the one that refused the 3s probe in production —
    // a bare @SkipThrottle() writes only `default` and fixes nothing.
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}default`, HealthController)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}expensive`, HealthController)).toBe(true);
  });
});
