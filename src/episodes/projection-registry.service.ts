import { Injectable, Logger } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';

export type ProjectionStatus = 'building' | 'built' | 'live' | 'residual' | 'failed';

export interface ProjectionRow {
  id: string;
  name: string;
  version: string;
  status: ProjectionStatus;
  builder: string;
  watermark?: string;
  startedAt: string;
  finishedAt?: string;
  stats?: Record<string, unknown>;
}

/**
 * Raw-substrate driver v1, surface 3
 * (docs/roadmap/raw-substrate-driver-2026-08.md): the lifecycle ledger of
 * derived surfaces. Builders (window-deriver today; segments/communities
 * as they migrate) record begin/complete/fail here, activation marks the
 * new live version and demotes the previous one, and gc deletes rows for
 * reaped worlds — a registry row promises a queryable world.
 *
 * Identity: record id projection:[name, version] (array-literal id,
 * UPSERT-idempotent — verified on 3.1.5). Every write degrades to a
 * warning, never breaks the builder: the registry OBSERVES derivation,
 * it must not be able to fail it.
 */
@Injectable()
export class ProjectionRegistryService {
  private readonly logger = new Logger(ProjectionRegistryService.name);

  constructor(private readonly surreal: SurrealService) {}

  /** Upsert (name, version) into `building`; clears any previous end-state. */
  async begin(opts: {
    companyId: string;
    name: string;
    version: string;
    builder: string;
  }): Promise<void> {
    await this.safely('begin', opts.companyId, async (db) => {
      await db.query(
        `UPSERT projection:[$name, $version] SET
           name = $name, version = $version, status = 'building',
           builder = $builder, startedAt = time::now(),
           finishedAt = NONE, watermark = NONE, stats = NONE`,
        { name: opts.name, version: opts.version, builder: opts.builder },
      );
    });
  }

  /** Mark (name, version) complete; `live` demotes the previous live row. */
  async complete(opts: {
    companyId: string;
    name: string;
    version: string;
    live: boolean;
    stats?: Record<string, unknown>;
  }): Promise<void> {
    await this.safely('complete', opts.companyId, async (db) => {
      if (opts.live) {
        await db.query(
          `UPDATE projection SET status = 'residual'
            WHERE name = $name AND version != $version AND status = 'live'`,
          { name: opts.name, version: opts.version },
        );
      }
      await db.query(
        `UPSERT projection:[$name, $version] SET
           name = $name, version = $version, status = $status,
           finishedAt = time::now(), watermark = time::now(), stats = $stats`,
        {
          name: opts.name,
          version: opts.version,
          status: opts.live ? 'live' : 'built',
          stats: opts.stats ?? null,
        },
      );
    });
  }

  /** Builder aborted; the world may be partial (a rebuild overwrites). */
  async fail(opts: { companyId: string; name: string; version: string }): Promise<void> {
    await this.safely('fail', opts.companyId, async (db) => {
      await db.query(
        `UPDATE projection:[$name, $version]
           SET status = 'failed', finishedAt = time::now()`,
        { name: opts.name, version: opts.version },
      );
    });
  }

  /**
   * Demote (name, version) to 'residual' WITHOUT deleting the row — the
   * verb for a PURGED world (Brain v2 scenes version purge): the ledger
   * keeps who built it and when, while 'residual' says it is no longer
   * queryable. UPDATE (not UPSERT) on the array-literal id: a version
   * that never registered stays absent rather than gaining a ghost row.
   */
  async markResidual(opts: { companyId: string; name: string; version: string }): Promise<void> {
    await this.safely('markResidual', opts.companyId, async (db) => {
      await db.query(
        `UPDATE projection:[$name, $version]
           SET status = 'residual', finishedAt = time::now()`,
        { name: opts.name, version: opts.version },
      );
    });
  }

  /** Reaped worlds lose their rows — a row promises a queryable world. */
  async dropVersions(opts: { companyId: string; name: string; versions: string[] }): Promise<void> {
    if (opts.versions.length === 0) return;
    await this.safely('dropVersions', opts.companyId, async (db) => {
      await db.query(`DELETE projection WHERE name = $name AND version INSIDE $versions`, {
        name: opts.name,
        versions: opts.versions,
      });
    });
  }

  async list(companyId: string): Promise<ProjectionRow[]> {
    return (
      (await this.safely('list', companyId, async (db) => {
        const [rows] = await db.query<[Array<ProjectionRow & { id: unknown }>]>(
          `SELECT * FROM projection ORDER BY name, startedAt DESC`,
        );
        return (rows ?? []).map((r) => ({ ...r, id: String(r.id) }));
      })) ?? []
    );
  }

  private async safely<T>(
    op: string,
    companyId: string,
    fn: (db: Surreal) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await this.surreal.withCompany(companyId, fn);
    } catch (e) {
      this.logger.warn(
        `projection registry ${op} failed (companyId=${companyId}): ${(e as Error).message}`,
      );
      return undefined;
    }
  }
}
