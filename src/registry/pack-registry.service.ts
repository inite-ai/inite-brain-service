import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import {
  DomainPackError,
  packChecksum,
  pickLatestVersion,
  compareSemver,
  validatePack,
  type DomainPackManifest,
} from '../ai/domain-packs';
import type {
  PublishPackResponse,
  RegistryManifestResponse,
  RegistryPackSummary,
  RegistryVersion,
  RegistryVersionsResponse,
  YankPackResponse,
} from '../contracts/registry/registry.schema';

interface RegistryRow {
  packId: string;
  version: string;
  manifest?: DomainPackManifest;
  checksum: string;
  description?: string;
  keywords?: string[];
  publisher?: string | null;
  signed?: boolean;
  yanked?: boolean;
  yankReason?: string | null;
  publishedAt: string;
}

/**
 * The GLOBAL Domain Pack registry (docs/domain-packs.md). A shared, tenant-
 * agnostic catalogue of published, installable packs — stored in the `system`
 * database via SurrealService.withAdminDb, distinct from the per-tenant
 * domain_pack table (which records what's INSTALLED).
 *
 * Invariants (supply-chain safety, npm/crates.io-style):
 *   - Version immutability: a (packId, version) is content-addressed by
 *     checksum. Republishing the same version with different content is a 409;
 *     an identical republish is idempotent.
 *   - Yank, not delete: a bad version is flagged yanked (excluded from latest-
 *     resolution + default listing) but never removed, so pinned installs stay
 *     reproducible.
 *   - Trust is end-to-end: the manifest's signature/publisher are stored as-is;
 *     cryptographic verification happens at INSTALL time against the installing
 *     tenant's trust store. The registry is a content store.
 */
@Injectable()
export class PackRegistryService {
  private readonly logger = new Logger(PackRegistryService.name);

  constructor(private readonly surreal: SurrealService) {}

  private requireSignature(): boolean {
    // envFlagEnabled accepts both '1' and 'true' — a 'true'-only check
    // silently disabled enforcement for operators using the house '1'
    // idiom (fail-open on a supply-chain control).
    return envFlagEnabled(process.env.PACK_REGISTRY_REQUIRE_SIGNATURE);
  }

  /** Publish a pack version into the global catalogue. Validates the manifest,
   *  enforces the (optional) signed-packs policy + version immutability, and
   *  stores it. Idempotent for an identical republish. */
  async publish(input: {
    manifest: DomainPackManifest;
    publishedBy?: string;
    keywords?: string[];
    expectedChecksum?: string;
  }): Promise<PublishPackResponse> {
    const { manifest } = input;
    if (!manifest || typeof manifest !== 'object') {
      throw new BadRequestException('request body must include a pack manifest');
    }
    try {
      validatePack(manifest);
    } catch (e) {
      if (e instanceof DomainPackError) throw new BadRequestException(e.message);
      throw e;
    }
    if (this.requireSignature() && !manifest.signature) {
      throw new BadRequestException(
        `pack "${manifest.id}" is unsigned but this registry requires signed packs`,
      );
    }
    const checksum = packChecksum(manifest);
    if (input.expectedChecksum && input.expectedChecksum !== checksum) {
      throw new BadRequestException(
        `checksum mismatch: expected ${input.expectedChecksum}, computed ${checksum}`,
      );
    }
    const keywords = (input.keywords ?? [])
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean);

    return this.surreal.withAdminDb(async (db) => {
      const [existing] = await db.query<[RegistryRow[]]>(
        `SELECT packId, version, checksum FROM registry_pack
           WHERE packId = $packId AND version = $version LIMIT 1`,
        { packId: manifest.id, version: manifest.version },
      );
      const prior = ((existing as RegistryRow[]) ?? [])[0];
      if (prior) {
        if (prior.checksum === checksum) {
          // Idempotent republish of identical content.
          return {
            packId: manifest.id,
            version: manifest.version,
            checksum,
            created: false,
          };
        }
        throw new ConflictException(
          `pack "${manifest.id}" version ${manifest.version} is already published with different content (immutable)`,
        );
      }
      // option<string> fields reject a JS null under SCHEMAFULL ("Found NULL,
      // expected option<...>") — omit them when absent so they store as NONE.
      const content: Record<string, unknown> = {
        packId: manifest.id,
        version: manifest.version,
        manifest,
        checksum,
        description: manifest.description ?? '',
        keywords,
        signed: Boolean(manifest.signature),
        yanked: false,
      };
      if (manifest.publisher) content.publisher = manifest.publisher;
      if (input.publishedBy) content.publishedBy = input.publishedBy;
      await db.query(`CREATE registry_pack CONTENT $content`, { content });
      this.logger.log(
        `Published pack ${manifest.id} v${manifest.version} (checksum ${checksum.slice(0, 12)}…)`,
      );
      return {
        packId: manifest.id,
        version: manifest.version,
        checksum,
        created: true,
      };
    });
  }

  /** Catalogue listing — one entry per pack (its latest non-yanked version),
   *  filtered by free-text q / publisher / tag. Packs with only yanked versions
   *  are omitted (nothing installable). */
  async list(filter: {
    q?: string;
    publisher?: string;
    tag?: string;
    limit?: number;
  }): Promise<RegistryPackSummary[]> {
    const rows = await this.allRows();
    const byPack = new Map<string, RegistryRow[]>();
    for (const r of rows) {
      const arr = byPack.get(r.packId) ?? [];
      arr.push(r);
      byPack.set(r.packId, arr);
    }
    const summaries: RegistryPackSummary[] = [];
    for (const [packId, versions] of byPack) {
      const installable = versions.filter((v) => !v.yanked);
      const latest = pickLatestVersion(installable.map((v) => v.version));
      if (!latest) continue; // only-yanked pack → not installable
      const row = installable.find((v) => v.version === latest)!;
      summaries.push({
        packId,
        latestVersion: latest,
        description: row.description ?? '',
        keywords: row.keywords ?? [],
        publisher: row.publisher ?? null,
        signed: Boolean(row.signed),
        versionCount: versions.length,
      });
    }
    const q = filter.q?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    const publisher = filter.publisher?.trim();
    const out = summaries.filter((s) => {
      if (publisher && s.publisher !== publisher) return false;
      if (tag && !s.keywords.includes(tag)) return false;
      if (q) {
        const hay = `${s.packId} ${s.description} ${s.keywords.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out.sort((a, b) => a.packId.localeCompare(b.packId));
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return out.slice(0, limit);
  }

  /** All versions of one pack, newest-first, with the latest non-yanked flagged. */
  async getVersions(packId: string): Promise<RegistryVersionsResponse> {
    const rows = (await this.allRows()).filter((r) => r.packId === packId);
    const versions = rows
      .map((r) => this.toVersion(r))
      .sort((a, b) => compareSemver(b.version, a.version));
    const latestVersion = pickLatestVersion(
      rows.filter((r) => !r.yanked).map((r) => r.version),
    );
    return { packId, latestVersion, versions };
  }

  /** Resolve a manifest for inspection. version omitted → latest non-yanked.
   *  An exact version is returned even if yanked (carrying the flag). */
  async getManifest(
    packId: string,
    version?: string,
  ): Promise<RegistryManifestResponse | null> {
    const row = await this.findRow(packId, version);
    if (!row || !row.manifest) return null;
    return {
      packId,
      version: row.version,
      checksum: row.checksum,
      yanked: Boolean(row.yanked),
      manifest: row.manifest as unknown as Record<string, unknown>,
    };
  }

  /** Resolve a manifest for INSTALL. Throws NotFound when nothing matches and
   *  BadRequest when a pinned version is yanked / no non-yanked version exists. */
  async resolveForInstall(
    packId: string,
    version?: string,
  ): Promise<{ manifest: DomainPackManifest; checksum: string }> {
    const row = await this.findRow(packId, version);
    if (!row || !row.manifest) {
      throw new NotFoundException(
        `pack "${packId}"${version ? ` version ${version}` : ''} not found in the registry`,
      );
    }
    if (row.yanked) {
      throw new BadRequestException(
        `pack "${packId}" version ${row.version} is yanked and cannot be installed`,
      );
    }
    return { manifest: row.manifest, checksum: row.checksum };
  }

  async yank(
    packId: string,
    version: string,
    reason?: string,
  ): Promise<YankPackResponse> {
    return this.setYanked({ packId, version, yanked: true, reason });
  }

  async unyank(packId: string, version: string): Promise<YankPackResponse> {
    return this.setYanked({ packId, version, yanked: false });
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async setYanked(args: {
    packId: string;
    version: string;
    yanked: boolean;
    reason?: string;
  }): Promise<YankPackResponse> {
    const { packId, version, yanked, reason } = args;
    return this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM registry_pack WHERE packId = $packId AND version = $version LIMIT 1`,
        { packId, version },
      );
      const row = ((rows as Array<{ id: unknown }>) ?? [])[0];
      if (!row) {
        throw new NotFoundException(
          `pack "${packId}" version ${version} not found in the registry`,
        );
      }
      // yankReason is option<string> — clear it to NONE (not null) on unyank or
      // a reasonless yank; bind it only when a reason is supplied.
      const params: Record<string, unknown> = { id: row.id, yanked };
      let reasonClause = 'yankReason = NONE';
      if (yanked && reason) {
        reasonClause = 'yankReason = $reason';
        params.reason = reason;
      }
      await db.query(
        `UPDATE $id SET yanked = $yanked, ${reasonClause}, updatedAt = time::now()`,
        params,
      );
      this.logger.log(
        `${yanked ? 'Yanked' : 'Unyanked'} pack ${packId} v${version}` +
          (yanked && reason ? ` (${reason})` : ''),
      );
      return { packId, version, yanked };
    });
  }

  /** Find one row: exact version, or the latest non-yanked when version omitted. */
  private async findRow(
    packId: string,
    version?: string,
  ): Promise<RegistryRow | null> {
    const rows = (await this.allRows()).filter((r) => r.packId === packId);
    if (rows.length === 0) return null;
    if (version) return rows.find((r) => r.version === version) ?? null;
    const latest = pickLatestVersion(
      rows.filter((r) => !r.yanked).map((r) => r.version),
    );
    return latest ? (rows.find((r) => r.version === latest) ?? null) : null;
  }

  private async allRows(): Promise<RegistryRow[]> {
    return this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[RegistryRow[]]>(
        `SELECT packId, version, manifest, checksum, description, keywords,
                publisher, signed, yanked, yankReason, publishedAt
           FROM registry_pack`,
      );
      return (rows as RegistryRow[]) ?? [];
    });
  }

  private toVersion(r: RegistryRow): RegistryVersion {
    return {
      packId: r.packId,
      version: r.version,
      checksum: r.checksum,
      description: r.description ?? '',
      keywords: r.keywords ?? [],
      publisher: r.publisher ?? null,
      signed: Boolean(r.signed),
      yanked: Boolean(r.yanked),
      yankReason: r.yankReason ?? null,
      publishedAt: new Date(r.publishedAt).toISOString(),
    };
  }
}
