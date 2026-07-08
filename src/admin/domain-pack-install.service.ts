import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { EmbedderService } from '../ai/embedder.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { seedMissingPredicates } from '../ai/predicate-registry-internals/seed-predicates';
import { embeddingTextFor, serializeForInsert } from '../ai/predicate-registry-internals/db-mapping';
import type { PredicateDefinition } from '../ai/predicate-registry-internals/types';
import {
  assertPackTrust,
  BUILTIN_PACKS,
  compareSemver,
  composePredicateId,
  diffPackUpgrade,
  DomainPackError,
  packChecksum,
  validatePack,
  type DomainPackManifest,
} from '../ai/domain-packs';

export interface InstalledPack {
  packId: string;
  version: string;
  installedAt: string;
  predicateCount: number;
  checksum: string | null;
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

  /** Trust store: publisher → PEM public key, from DOMAIN_PACK_TRUSTED_KEYS
   *  (JSON). Empty when unset — then only unsigned packs install (unless
   *  DOMAIN_PACK_REQUIRE_SIGNATURE forces signing). */
  private trustedKeys(): Record<string, string> {
    try {
      return JSON.parse(process.env.DOMAIN_PACK_TRUSTED_KEYS ?? '{}');
    } catch (e) {
      // Loud, not silent: a JSON typo here empties the trust store and
      // every signed pack starts failing as "unknown publisher" with no
      // hint at the real cause. validateEnv also rejects this at boot;
      // the log covers env drift after start.
      this.logger.error(
        `DOMAIN_PACK_TRUSTED_KEYS is not valid JSON (${(e as Error).message}) — treating trust store as EMPTY`,
      );
      return {};
    }
  }

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
        `SELECT packId, version, installedAt, manifest, checksum FROM domain_pack WHERE status = 'active'`,
      );
      return ((rows as any[]) ?? []).map((r) => ({
        packId: String(r.packId),
        version: String(r.version),
        installedAt: new Date(r.installedAt).toISOString(),
        predicateCount: Array.isArray(r.manifest?.predicates)
          ? r.manifest.predicates.length
          : 0,
        checksum: r.checksum ? String(r.checksum) : null,
      }));
    });
  }

  async install(
    companyId: string,
    manifest: DomainPackManifest,
    opts: { expectedChecksum?: string } = {},
  ): Promise<{
    packId: string;
    version: string;
    predicatesSeeded: number;
    checksum: string;
  }> {
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
    try {
      assertPackTrust({
        manifest,
        trustedKeys: this.trustedKeys(),
        requireSignature: envFlagEnabled(
          process.env.DOMAIN_PACK_REQUIRE_SIGNATURE,
        ),
      });
    } catch (e) {
      if (e instanceof DomainPackError) throw new BadRequestException(e.message);
      throw e;
    }
    const checksum = packChecksum(manifest);
    if (opts.expectedChecksum && opts.expectedChecksum !== checksum) {
      throw new BadRequestException(
        `checksum mismatch: expected ${opts.expectedChecksum}, computed ${checksum}`,
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

    const newIds = predicates.map((p) => p.predicateId);
    const seeded = await this.surreal.withCompany(companyId, async (db) => {
      const [existing] = await db.query<[any[]]>(
        `SELECT id, version, manifest FROM domain_pack WHERE packId = $packId LIMIT 1`,
        { packId: manifest.id },
      );
      const row = ((existing as any[]) ?? [])[0];
      if (row) {
        // Reject a silent version downgrade — an out-of-order replay or a
        // stale artifact must not quietly roll a tenant's ontology back.
        if (compareSemver(manifest.version, String(row.version)) < 0) {
          throw new BadRequestException(
            `pack "${manifest.id}" v${manifest.version} is older than the installed v${row.version}; refusing to downgrade`,
          );
        }
        const { changed, removedIds } = diffPackUpgrade(
          manifest.id,
          row.manifest as DomainPackManifest | undefined,
          manifest,
        );
        await db.query(
          `UPDATE $id SET version = $version, manifest = $manifest, checksum = $checksum, status = 'active', updatedAt = time::now()`,
          { id: row.id, version: manifest.version, manifest, checksum },
        );
        // Reinstall/upgrade: uninstall DEPRECATED this pack's predicates and
        // seedMissingPredicates skips them (they exist by id), so without this
        // they'd stay out of the active snapshot forever — the pack would read
        // as installed but extract nothing. Reactivate the pack-owned rows the
        // NEW manifest still declares (scoped to $newIds, so a predicate this
        // upgrade dropped is NOT revived below; createdBy='admin' guards
        // against reviving an operator's manual deprecation of a core id).
        if (newIds.length) {
          await db.query(
            `UPDATE knowledge_predicate SET status = 'active', updatedAt = time::now()
               WHERE predicateId IN $newIds
                 AND status = 'deprecated'
                 AND createdBy = 'admin'`,
            { newIds },
          );
        }
        // Apply redefined predicates. seedMissingPredicates only CREATEs absent
        // ids, so an upgrade that edits a predicate (piiClass, semantics,
        // description, …) would otherwise leave the tenant frozen at
        // first-install values. MERGE preserves createdAt/version; re-embed the
        // card since the description feeds the embedding.
        await this.applyChangedPredicates(db, manifest.id, changed);
        // Deprecate predicates the new manifest dropped (present before, gone
        // now) — facts on them survive; they just leave the active vocab.
        if (removedIds.length) {
          await db.query(
            `UPDATE knowledge_predicate SET status = 'deprecated', updatedAt = time::now()
               WHERE predicateId IN $removedIds
                 AND status != 'deprecated'
                 AND createdBy = 'admin'`,
            { removedIds },
          );
        }
      } else {
        await db.query(`CREATE domain_pack CONTENT $content`, {
          content: {
            packId: manifest.id,
            version: manifest.version,
            manifest,
            checksum,
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
    return {
      packId: manifest.id,
      version: manifest.version,
      predicatesSeeded: seeded,
      checksum,
    };
  }

  /** Re-write redefined pack predicates on upgrade. MERGE (not CONTENT) so
   *  createdAt/version survive; re-embed since the card text changed. Scoped to
   *  createdBy='admin' so an operator's edits to a same-named row aren't
   *  clobbered. */
  private async applyChangedPredicates(
    db: Surreal,
    packId: string,
    changed: PredicateDefinition[],
  ): Promise<void> {
    if (changed.length === 0) return;
    let embeddings: Array<number[] | null>;
    try {
      embeddings = await this.embedder.embedMany(
        changed.map((p) => embeddingTextFor(p)),
      );
    } catch {
      embeddings = changed.map(() => null);
    }
    for (let i = 0; i < changed.length; i++) {
      await db.query(
        `UPDATE knowledge_predicate MERGE $content
           WHERE predicateId = $pid AND createdBy = 'admin'`,
        {
          pid: changed[i].predicateId,
          content: {
            ...serializeForInsert(changed[i]),
            ...(embeddings[i] ? { embedding: embeddings[i] } : {}),
          },
        },
      );
    }
    this.logger.log(
      `[pack ${packId}] applied ${changed.length} redefined predicate(s)`,
    );
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
