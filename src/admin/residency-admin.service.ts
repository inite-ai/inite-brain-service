import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { REGION_RE } from '../db/residency';

/** The residency directory as the admin surface uses it (#916 step 3). */
@Injectable()
export class ResidencyAdminService {
  constructor(private readonly surreal: SurrealService) {}

  get deploymentRegion(): string {
    return this.surreal.residency.region;
  }

  pinOf(companyId: string): Promise<string | null> {
    return this.surreal.residency.pinOf(companyId);
  }

  /**
   * Pin a tenant. Never moves data: a tenant that already has a database
   * here cannot be pinned to another region (409).
   */
  async pin(companyId: string, rawRegion: string, by: string | undefined): Promise<string> {
    const region = rawRegion.trim().toLowerCase();
    if (!REGION_RE.test(region)) throw new BadRequestException('region must be a region name');
    if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) throw new BadRequestException('invalid companyId');
    const here = this.deploymentRegion;
    if (region !== here && (await this.hasDatabaseHere(companyId))) {
      throw new ConflictException(
        `workspace has data in region "${here}"; moving it is an export and import, not a pin`,
      );
    }
    await this.surreal.residency.pin(companyId, region, by);
    return region;
  }

  private async hasDatabaseHere(companyId: string): Promise<boolean> {
    return this.surreal.withAdminDb(async (db) => {
      const [info] = await db.query<[{ databases?: Record<string, unknown> }]>(`INFO FOR NS`);
      return Object.prototype.hasOwnProperty.call(info?.databases ?? {}, `co_${companyId}`);
    });
  }
}
