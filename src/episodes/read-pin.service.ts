import { Injectable, Logger, Optional } from '@nestjs/common';
import { ProjectionRegistryService } from './projection-registry.service';

/** Short cache TTL: a world flip must land within one page-refresh. */
const CACHE_TTL_MS = 5_000;

/**
 * Which derived world the read path serves, per tenant.
 *
 * Audit W2 (engine-architecture-audit-2026-08.md #9): the pin used to be
 * `process.env.RETRIEVAL_DERIVED_VERSION`, MUTATED at runtime by
 * `window-deriver.run({activate:true})`. That is a per-tenant input with
 * a process-global effect — activating tenant A's world repointed every
 * other tenant on the pod at a namespace where their memory does not
 * exist; other pods and worker-role processes never saw the flip at all;
 * a restart silently rolled back; and the registry row that said
 * `status='live'` was a DB truth no reader consulted.
 *
 * Now the registry IS the pin. `projection` rows (migration 0076) are
 * per-tenant and durable, so every pod resolves the same world and a
 * restart changes nothing. The env var survives as the BOOTSTRAP default
 * for tenants with no registry row yet (eval runners pin it this way),
 * never as mutable state.
 */
@Injectable()
export class ReadPinService {
  private readonly logger = new Logger(ReadPinService.name);
  private readonly cache = new Map<
    string,
    { version: string | null; at: number }
  >();

  constructor(
    @Optional() private readonly registry?: ProjectionRegistryService,
  ) {}

  /** The env bootstrap default (no registry evidence yet, or no registry). */
  static bootstrapDefault(): string | null {
    return process.env.RETRIEVAL_DERIVED_VERSION?.trim() || null;
  }

  /**
   * Live derived version for this tenant, or null for the legacy
   * namespace. Registry `live` row wins; otherwise the env bootstrap.
   * Registry failures degrade to the bootstrap rather than emptying a
   * tenant's memory.
   */
  async resolve(companyId: string): Promise<string | null> {
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.version;

    let version = ReadPinService.bootstrapDefault();
    if (this.registry) {
      try {
        const rows = await this.registry.list(companyId);
        const live = rows.find(
          (r) => r.name === 'facts' && r.status === 'live',
        );
        if (live) version = live.version;
      } catch (e) {
        this.logger.warn(
          `read-pin resolve fell back to the bootstrap default ` +
            `(companyId=${companyId}): ${(e as Error).message}`,
        );
      }
    }
    this.cache.set(companyId, { version, at: Date.now() });
    return version;
  }

  /** Drop the cached pin after an activation so readers see it at once. */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }
}
