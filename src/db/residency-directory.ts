import { Logger } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { MisdirectedTenantError, REGION_RE, residencyDecision } from './residency';

/** How long the in-memory directory serves before it is re-read. */
const DIRECTORY_TTL_MS = 30_000;

/**
 * The deployment's copy of the residency directory (0191 `tenant_residency`
 * in the system database), held in memory: a residency check runs before
 * every tenant database is opened, so it is a map lookup, re-read every 30
 * s and at once after a pin. A read failure keeps the last directory; with
 * none ever read, the check fails closed — serving a tenant in the wrong
 * region is worse than refusing a request.
 */
export class ResidencyDirectory {
  private readonly logger = new Logger(ResidencyDirectory.name);
  private pins: Map<string, string> | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly adminDb: <T>(fn: (db: Surreal) => Promise<T>) => Promise<T>,
    readonly region: string,
  ) {}

  /** Throws MisdirectedTenantError (421) unless this deployment serves the tenant. */
  async assert(companyId: string): Promise<void> {
    const pins = await this.directory();
    const decision = residencyDecision(pins.get(companyId) ?? null, this.region);
    if (!decision.serve) throw new MisdirectedTenantError(decision.region);
  }

  async pinOf(companyId: string): Promise<string | null> {
    return (await this.directory()).get(companyId) ?? null;
  }

  async pin(companyId: string, region: string, by: string | undefined): Promise<void> {
    if (!REGION_RE.test(region)) throw new Error(`"${region}" is not a region name`);
    await this.adminDb(async (db) => {
      await db.query(
        `LET $old = (SELECT VALUE id FROM tenant_residency WHERE companyId = $c);
         DELETE $old;
         CREATE tenant_residency CONTENT { companyId: $c, region: $r, assignedBy: $by };`,
        { c: companyId, r: region, by },
      );
    });
    this.loadedAt = 0;
  }

  private async directory(): Promise<Map<string, string>> {
    if (this.pins && Date.now() - this.loadedAt < DIRECTORY_TTL_MS) return this.pins;
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    await this.loading;
    if (!this.pins) throw new MisdirectedTenantError(null);
    return this.pins;
  }

  private async load(): Promise<void> {
    try {
      const rows = await this.adminDb(async (db) => {
        const [r] = await db.query<[Array<{ companyId: string; region: string }>]>(
          `SELECT companyId, region FROM tenant_residency`,
        );
        return r ?? [];
      });
      this.pins = new Map(rows.map((r) => [r.companyId, r.region]));
      this.loadedAt = Date.now();
    } catch (e) {
      this.logger.warn(`residency directory read failed: ${(e as Error).message}`);
    }
  }
}
