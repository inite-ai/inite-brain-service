/**
 * Circuit breaker per (provider, model) for chat calls (#853; Nygard,
 * *Release It!*). A provider that is down used to cost every caller a full
 * timeout plus the SDK's retries before the fallback was even tried. After
 * LLM_BREAKER_FAILURES consecutive provider-side failures the circuit opens
 * and calls go straight to the fallback (or fail fast without one); after
 * LLM_BREAKER_COOLDOWN_MS one call is let through as a probe — its success
 * closes the circuit, its failure opens it for another cool-down.
 *
 * Only provider-side failures count (openai-client.ts providerSideFailure):
 * a 400 about the request says nothing about the provider's health.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerSettings {
  failures: number;
  cooldownMs: number;
}

/** LLM_BREAKER_FAILURES / LLM_BREAKER_COOLDOWN_MS from whatever the client is configured by. */
export function breakerSettings(read: (key: string) => string | undefined): BreakerSettings {
  const int = (raw: string | undefined, dflt: number) => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    failures: int(read('LLM_BREAKER_FAILURES'), 5),
    cooldownMs: int(read('LLM_BREAKER_COOLDOWN_MS'), 30_000),
  };
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutive = 0;
  private openedAt = 0;
  private probing = false;

  constructor(private readonly settings: () => BreakerSettings) {}

  /** May a call go out now? In half-open, only the one probe may. */
  allow(now: number = Date.now()): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (now - this.openedAt < this.settings().cooldownMs) return false;
      this.state = 'half_open';
      this.probing = false;
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void {
    this.state = 'closed';
    this.consecutive = 0;
    this.probing = false;
  }

  onFailure(now: number = Date.now()): void {
    this.consecutive += 1;
    if (this.state === 'half_open' || this.consecutive >= this.settings().failures) {
      this.state = 'open';
      this.openedAt = now;
      this.probing = false;
    }
  }

  /** A call that ended with neither verdict (a request-side error) frees a held probe. */
  onNeutral(): void {
    this.probing = false;
  }

  current(): BreakerState {
    return this.state;
  }
}

const breakers = new Map<string, CircuitBreaker>();

/** The breaker for one (provider, model) route — one per process, read with the caller's settings. */
export function breakerFor(route: string, settings: () => BreakerSettings): CircuitBreaker {
  let b = breakers.get(route);
  if (!b) breakers.set(route, (b = new CircuitBreaker(settings)));
  return b;
}

/** Route → state, for the metrics gauge. */
export function breakerStates(): ReadonlyMap<string, CircuitBreaker> {
  return breakers;
}

/** Test seam. */
export function resetBreakers(): void {
  breakers.clear();
}
