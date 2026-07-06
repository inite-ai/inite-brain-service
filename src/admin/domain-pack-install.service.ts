import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { seedMissingPredicates } from '../ai/predicate-registry-internals/seed-predicates';
import type { PredicateDefinition } from '../ai/predicate-registry-internals/types';
import {
  BUILTIN_PACKS,
  composePredicateId,
  DomainPackError,
  validatePack,
  type DomainPackManifest,
} from '../ai/domain-packs';

export interface InstalledPack {
  packId: string;
  version: string;
  installedAt: string;
  predicateCount: number;
}

export interface AvailablePack {
  id: string;
  version: string;
  description: string;
  predicateCount: number;
  builtin: boolean;
}

/**
 * Runtime per-tenant Domain Pack install (docs/domain-packs.md). Additive to
 * the builtin packs, which stay globally seeded via SEED_PREDICATES: this lets
 * an admin install a community / custom pack manifest into ONE tenant without a
 * redeploy. Installing seeds the pack's namespaced predicates into
 * knowledge_predicate (same path as bootstrap); uninstalling DEPRECATES them
 * (never hard-deletes — recorded facts must survive).
 */
@Injectable()
export class DomainPackInstallService {
  private readonly logger = new Logger(DomainPackInstallService.name);
  private readonly builtinIds = new Set(BUILTIN_PACKS.map((p) => p.id));

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly registry: PredicateRegistryService,
  ) {}

  listAvailable(): AvailablePack[] {
    return BUILTIN_PACKS.map((p) => ({
      id: p.id,
      version: p.version,
      description: p.description,
      predicateCount: p.predicates.length,
      builtin: true,
    }));
  }

  async listInstalled(companyId: string): Promise<InstalledPack[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT packId, version, installedAt, manifest FROM domain_pack WHERE status = 'active'`,
      );
      return ((rows as any[]) ?? []).map((r) => ({
        packId: String(r.packId),
        version: String(r.version),
        installedAt: new Date(r.installedAt).toISOString(),
        predicateCount: Array.isArray(r.manifest?.predicates)
          ? r.manifest.predicates.length
          : 0,
      }));
    });
  }

  async install(
    companyId: string,
    manifest: DomainPackManifest,
  ): Promise<{ packId: string; version: string; predicatesSeeded: number }> {
    if (!manifest || typeof manifest !== 'object') {
      throw new BadRequestException('request body must include a pack manifest');
    }
    try {
      validatePack(manifest);
    } catch (e) {
      if (e instanceof DomainPackError) throw new BadRequestException(e.message);
      throw e;
    }
    if (this.builtinIds.has(manifest.id)) {
      throw new BadRequestException(
        `pack id "${manifest.id}" is reserved by a builtin pack and is already globally available`,
      );
    }

    const predicates: PredicateDefinition[] = manifest.predicates.map((p) => {
      const { localId, ...rest } = p;
      return {
        ...rest,
        predicateId: composePredicateId(manifest.id, localId),
        createdBy: 'admin',
      };
    });

    const seeded = await this.surreal.withCompany(companyId, async (db) => {
      const [existing] = await db.query<[any[]]>(
        `SELECT id FROM domain_pack WHERE packId = $packId LIMIT 1`,
        { packId: manifest.id },
      );
      const row = ((existing as any[]) ?? [])[0];
      if (row) {
        await db.query(
          `UPDATE $id SET version = $version, manifest = $manifest, status = 'active', updatedAt = time::now()`,
          { id: row.id, version: manifest.version, manifest },
        );
      } else {
        await db.query(`CREATE domain_pack CONTENT $content`, {
          content: {
            packId: manifest.id,
            version: manifest.version,
            manifest,
            status: 'active',
          },
        });
      }
      return seedMissingPredicates({
        db,
        predicates,
        embedder: this.embedder,
        log: (m) => this.logger.log(`[pack ${manifest.id}] ${m}`),
      });
    });

    this.registry.invalidate(companyId);
    this.logger.log(
      `Installed pack ${manifest.id} v${manifest.version} into ${companyId} (${seeded} predicate(s) seeded)`,
    );
    return { packId: manifest.id, version: manifest.version, predicatesSeeded: seeded };
  }

  async uninstall(
    companyId: string,
    packId: string,
  ): Promise<{ packId: string; predicatesDeprecated: number }> {
    if (this.builtinIds.has(packId)) {
      throw new BadRequestException(
        `pack "${packId}" is a builtin pack and cannot be uninstalled`,
      );
    }
    const deprecated = await this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT id FROM domain_pack WHERE packId = $packId AND status = 'active' LIMIT 1`,
        { packId },
      );
      const row = ((rows as any[]) ?? [])[0];
      if (!row) {
        throw new NotFoundException(`pack "${packId}" is not installed`);
      }
      // Deprecate the pack's predicates (status only — facts on them survive).
      const prefix = `${packId}__`;
      const [updated] = await db.query<[any[]]>(
        `UPDATE knowledge_predicate SET status = 'deprecated'
           WHERE string::starts_with(predicateId, $prefix) AND status != 'deprecated'
           RETURN AFTER`,
        { prefix },
      );
      await db.query(
        `UPDATE $id SET status = 'removed', updatedAt = time::now()`,
        { id: row.id },
      );
      return ((updated as any[]) ?? []).length;
    });

    this.registry.invalidate(companyId);
    this.logger.log(
      `Uninstalled pack ${packId} from ${companyId} (${deprecated} predicate(s) deprecated)`,
    );
    return { packId, predicatesDeprecated: deprecated };
  }
}
