import { Injectable, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { LRUCache } from '../common/lru-cache';
import {
  composePredicateId,
  mcpToolsChecksum,
  validateMcpTools,
  DomainPackError,
  type DomainPackManifest,
  type PackToolSpec,
} from '../ai/domain-packs';

/** One installed, consented pack's MCP tool surface. */
export interface PackToolBinding {
  packId: string;
  version: string;
  /** Opaque per-install identity for external tool calls (0068). */
  installId: string | null;
  /** HMAC key for external tool calls (0065/0068). */
  webhookSecret: string | null;
  tools: PackToolSpec[];
  /** ALL of the pack's namespaced predicate ids — the query-tool fence. */
  namespacedPredicates: Set<string>;
}

const DEFAULT_TTL_MS = 30_000;
const CACHE_CAP = 200;

/**
 * Read side of pack-declared MCP tools: which packs are installed,
 * consented, and structurally valid for this tenant. Sits on the MCP
 * hot path (every buildServer under MCP_PACK_TOOLS_ENABLED), hence the
 * LRU+TTL cache with in-flight dedupe (PredicateRegistryService.
 * getSnapshot mold). Fail-open to [] on read errors — a domain_pack
 * hiccup must not take down the whole MCP surface; the static tool
 * families keep working and pack tools reappear on the next load.
 */
@Injectable()
export class PackToolsReaderService {
  private readonly logger = new Logger(PackToolsReaderService.name);
  private readonly cache = new LRUCache<
    string,
    { bindings: PackToolBinding[]; loadedAt: number }
  >(CACHE_CAP);
  private readonly inFlight = new Map<string, Promise<PackToolBinding[]>>();

  constructor(private readonly surreal: SurrealService) {}

  async installedPackTools(companyId: string): Promise<PackToolBinding[]> {
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.loadedAt < ttlMs()) {
      return cached.bindings;
    }
    const inFlight = this.inFlight.get(companyId);
    if (inFlight) return inFlight;
    const load = this.loadFresh(companyId)
      .then((bindings) => {
        this.cache.set(companyId, { bindings, loadedAt: Date.now() });
        return bindings;
      })
      .catch((e) => {
        this.logger.warn(
          `pack tool load failed for ${companyId} (${(e as Error).message}) — serving no pack tools`,
        );
        return [] as PackToolBinding[];
      })
      .finally(() => this.inFlight.delete(companyId));
    this.inFlight.set(companyId, load);
    return load;
  }

  /** Called by DomainPackInstallService next to registry.invalidate. */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  private async loadFresh(companyId: string): Promise<PackToolBinding[]> {
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<Record<string, unknown>>(
        db,
        `SELECT packId, version, manifest, installId, webhookSecret,
                acceptedMcpTools, acceptedMcpToolsChecksum
           FROM domain_pack
          WHERE status = 'active' AND manifest.mcpTools != NONE`,
      ),
    );
    const bindings: PackToolBinding[] = [];
    for (const row of rows) {
      const binding = this.toBinding(row);
      if (binding) bindings.push(binding);
    }
    return bindings;
  }

  /**
   * Row → binding, defensively: consent must be on record for EXACTLY
   * the stored section (checksum match), and the section must still
   * pass validateMcpTools — a manifest written by an older/newer server
   * version never reaches registration half-checked.
   */
  private toBinding(row: Record<string, unknown>): PackToolBinding | null {
    const manifest = row.manifest as DomainPackManifest | undefined;
    if (
      !manifest ||
      !Array.isArray(manifest.mcpTools) ||
      manifest.mcpTools.length === 0
    ) {
      return null;
    }
    if (
      row.acceptedMcpTools !== true ||
      String(row.acceptedMcpToolsChecksum ?? '') !== mcpToolsChecksum(manifest)
    ) {
      return null;
    }
    try {
      validateMcpTools(manifest, manifest.mcpTools);
    } catch (e) {
      if (e instanceof DomainPackError) {
        this.logger.warn(
          `pack ${row.packId}: stored mcpTools failed validation (${e.message}) — skipped`,
        );
        return null;
      }
      throw e;
    }
    const packId = String(row.packId);
    return {
      packId,
      version: String(row.version),
      installId: row.installId ? String(row.installId) : null,
      webhookSecret: row.webhookSecret ? String(row.webhookSecret) : null,
      tools: manifest.mcpTools,
      namespacedPredicates: new Set(
        manifest.predicates.map((p) => composePredicateId(packId, p.localId)),
      ),
    };
  }
}

function ttlMs(): number {
  const v = Number(process.env.MCP_PACK_TOOLS_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}
