/**
 * Token-bucket semaphore for bounding concurrent async operations.
 *
 * Why hand-rolled: we don't need backpressure timing, queue priority,
 * or cancellation — only "no more than N in flight." A 30-line
 * primitive avoids pulling in p-limit + its transitive deps.
 *
 * Use for: throttling concurrent OpenAI calls below the per-key
 * rate-limit ceiling. Without it, a burst of ingest requests can
 * fan-out to enough simultaneous embed/extract calls to trip 429s.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  inFlight(): number {
    return this.active;
  }

  pending(): number {
    return this.waiters.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
