import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { retryOnUniqueViolation } from '../db/surreal-retry';
import { envFlagEnabled } from '../common/env-validation';
import {
  BUILTIN_PACKS,
  DomainPackError,
  packChecksum,
  pickLatestVersion,
  compareSemver,
  validatePack,
  verifyPackSignature,
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
  verified?: boolean;
  yanked?: boolean;
  yankReason?: string | null;
  publishedAt: string;
  downloads?: number;
  /** Upstream base URL the row was mirrored from; NONE = local publish. */
  origin?: string | null;
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
 *     tenant's trust store. The registry is a content store. The `verified`
 *     flag it stamps at publish time (hosting instance's trust store) is a
 *     discovery badge, not a substitute for that boundary.
 */
@Injectable()
export class PackRegistryService {
  private readonly logger = new Logger(PackRegistryService.name);
  private readonly builtinIds = new Set(BUILTIN_PACKS.map((p) => p.id));

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
    /** Set by the pull-only mirror (RegistryMirrorService): the upstream
     *  base URL the version was pulled from. Never set on operator
     *  publishes — the field is what fences mirrored yanks off local rows. */
    origin?: string;
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
    // A builtin pack id is globally seeded, not installable from the registry —
    // publishing one would let anyone squat the reserved namespace and shadow
    // core ontology at the discovery layer.
    if (this.builtinIds.has(manifest.id)) {
      throw new BadRequestException(
        `pack id "${manifest.id}" is reserved by a builtin pack and cannot be published`,
      );
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
    // Guard against a non-array keywords body ({} / string): .map would throw a
    // raw 500. Coerce to [] and normalize.
    const keywords = (Array.isArray(input.keywords) ? input.keywords : [])
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean);
    // NOTE: `verified` reflects the HOSTING instance's trust store AT PUBLISH
    // TIME — a discovery/UX badge, not a security gate. Install-time
    // verification against the INSTALLING tenant's own trust store
    // (assertPackTrust) remains the real security boundary. Unsigned or
    // failing verification is NOT an error here: publishing unsigned stays
    // allowed unless PACK_REGISTRY_REQUIRE_SIGNATURE (above) says otherwise.
    const verified = this.verifiedAtPublish(manifest);

    // Concurrent publishes of the same (packId, version) both pass the SELECT
    // (no prior) and race to CREATE; the UNIQUE index turns the loser's write
    // into a violation. retryOnUniqueViolation re-runs the closure — the retry's
    // SELECT now sees the winner's row and resolves to idempotent-or-409 instead
    // of surfacing a raw 500.
    return this.surreal.withAdminDb((db) =>
      retryOnUniqueViolation(async () => {
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
          verified,
          downloads: 0,
          yanked: false,
        };
        if (manifest.publisher) content.publisher = manifest.publisher;
        if (input.publishedBy) content.publishedBy = input.publishedBy;
        if (input.origin) content.origin = input.origin;
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
      }),
    );
  }

  /** Catalogue listing — one entry per pack (its latest non-yanked version),
   *  filtered by free-text q / publisher / tag. Packs with only yanked versions
   *  are omitted (nothing installable). */
  async list(filter: {
    q?: string;
    publisher?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<RegistryPackSummary[]> {
    // Manifest-less projection: the summary needs none of the (potentially
    // large) manifest JSON, and this path serves the public UI on every hit.
    const rows = await this.allRows({ includeManifest: false });
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
        verified: Boolean(row.verified),
        // Adoption over the pack's whole history — SUM across all versions
        // (yanked included: those installs happened), not just the latest.
        downloads: versions.reduce((n, v) => n + Number(v.downloads ?? 0), 0),
        publishedAt: new Date(row.publishedAt).toISOString(),
        versionCount: versions.length,
        ...(row.origin ? { origin: row.origin } : {}),
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
    // Offset + capped limit: a catalogue larger than one page was previously
    // truncated at the 500th pack with no way to reach the rest. Clients page by
    // advancing offset until an empty page comes back.
    const offset = Math.max(filter.offset ?? 0, 0);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return out.slice(offset, offset + limit);
  }

  /** All versions of one pack, newest-first, with the latest non-yanked flagged. */
  async getVersions(packId: string): Promise<RegistryVersionsResponse> {
    // packId-scoped + manifest-less: version metadata carries no manifest, and
    // the packId index avoids a full-table scan.
    const rows = await this.rowsForPack(packId, { includeManifest: false });
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
    // Download accounting lives HERE and only here: resolveForInstall serves
    // the install path (POST /v1/admin/packs/from-registry). Catalogue
    // browsing / manifest inspection (list/getVersions/getManifest) must not
    // count. Best-effort: a failed counter write never fails the install.
    // Keyed by the UNIQUE (packId, version) index — a single-row update.
    try {
      await this.surreal.withAdminDb((db) =>
        db.query(
          `UPDATE registry_pack SET downloads += 1
             WHERE packId = $packId AND version = $version`,
          { packId, version: row.version },
        ),
      );
    } catch (e) {
      this.logger.warn(
        `Failed to count download for ${packId}@${row.version}: ${(e as Error).message}`,
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

  /** Find one row (WITH manifest — this feeds getManifest/resolveForInstall):
   *  exact version, or the latest non-yanked when version omitted. */
  private async findRow(
    packId: string,
    version?: string,
  ): Promise<RegistryRow | null> {
    const rows = await this.rowsForPack(packId, { includeManifest: true });
    if (rows.length === 0) return null;
    if (version) return rows.find((r) => r.version === version) ?? null;
    const latest = pickLatestVersion(
      rows.filter((r) => !r.yanked).map((r) => r.version),
    );
    return latest ? (rows.find((r) => r.version === latest) ?? null) : null;
  }

  /** Manifest is the one heavy column; every read path except manifest
   *  inspection / install-resolution wants it dropped. */
  private projection(includeManifest: boolean): string {
    return `packId, version,${includeManifest ? ' manifest,' : ''} checksum,
            description, keywords, publisher, signed, verified, yanked,
            yankReason, publishedAt, downloads, origin`;
  }

  /** One pack's rows, packId-index scoped (no full-table scan). */
  private async rowsForPack(
    packId: string,
    opts: { includeManifest: boolean },
  ): Promise<RegistryRow[]> {
    return this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[RegistryRow[]]>(
        `SELECT ${this.projection(opts.includeManifest)} FROM registry_pack
           WHERE packId = $packId`,
        { packId },
      );
      return (rows as RegistryRow[]) ?? [];
    });
  }

  private async allRows(
    opts: { includeManifest: boolean } = { includeManifest: true },
  ): Promise<RegistryRow[]> {
    return this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[RegistryRow[]]>(
        `SELECT ${this.projection(opts.includeManifest)} FROM registry_pack`,
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
      verified: Boolean(r.verified),
      yanked: Boolean(r.yanked),
      yankReason: r.yankReason ?? null,
      publishedAt: new Date(r.publishedAt).toISOString(),
      downloads: Number(r.downloads ?? 0),
      ...(r.origin ? { origin: r.origin } : {}),
    };
  }

  /** Trust store: publisher → PEM public key, from DOMAIN_PACK_TRUSTED_KEYS
   *  (JSON) — the SAME store the install path uses (DomainPackInstallService).
   *  Empty when unset; a JSON typo is logged loudly and treated as empty
   *  (validateEnv also rejects it at boot — this covers env drift after). */
  private trustedKeys(): Record<string, string> {
    try {
      return JSON.parse(process.env.DOMAIN_PACK_TRUSTED_KEYS ?? '{}');
    } catch (e) {
      this.logger.error(
        `DOMAIN_PACK_TRUSTED_KEYS is not valid JSON (${(e as Error).message}) — treating trust store as EMPTY`,
      );
      return {};
    }
  }

  /** verified-at-publish: true only when the manifest names a publisher whose
   *  key is in THIS hosting instance's trust store AND its ed25519 signature
   *  validates against that key. Unsigned / unknown publisher / bad signature
   *  → false, never an error (see the publish-time NOTE). */
  private verifiedAtPublish(manifest: DomainPackManifest): boolean {
    if (!manifest.signature || !manifest.publisher) return false;
    const key = this.trustedKeys()[manifest.publisher];
    if (!key) return false;
    return verifyPackSignature(manifest, key);
  }
}
