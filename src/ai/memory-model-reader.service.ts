import { Injectable, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { LRUCache } from '../common/lru-cache';
import {
  BUILTIN_PACKS,
  validateMemoryModel,
  DomainPackError,
  type DomainPackManifest,
  type PackMemoryModel,
} from './domain-packs';

/** One installed pack's declared memory model (perception contract). */
export interface PackMemoryModelBinding {
  packId: string;
  packVersion: string;
  memoryModel: PackMemoryModel;
}

const DEFAULT_TTL_MS = 30_000;
const CACHE_CAP = 200;

/**
 * Read side of pack-declared memory models: the BUILTIN_PACKS' declared
 * memoryModels (globally seeded, in-process manifests) unioned with the
 * active installed packs' declarations for this tenant
 * (PackToolsReaderService mold — LRU+TTL cache with in-flight dedupe).
 * The builtin leg mirrors PackEvalService.resolveManifest and the
 * extraction-profile assembly in PredicateRegistryService.loadFresh:
 * builtins never pass through install (DomainPackInstallService rejects
 * their ids), so without this union a builtin's memoryModel would be
 * invisible to every consumer. Builtins are static for the process
 * lifetime, so their bindings are assembled once and merged AFTER the
 * per-tenant cache read — the cache keeps holding exactly the DB-derived
 * bindings it held before. Fail-open on read errors degrades to
 * builtins-only — a domain_pack hiccup must not take down a consumer;
 * installed models reappear on the next load. NO consent gate by design:
 * a memoryModel is declarative data with zero egress (see the decision
 * note in DomainPackInstallService).
 */
@Injectable()
export class MemoryModelReaderService {
  private readonly logger = new Logger(MemoryModelReaderService.name);
  private readonly cache = new LRUCache<
    string,
    { bindings: PackMemoryModelBinding[]; loadedAt: number }
  >(CACHE_CAP);
  private readonly inFlight = new Map<string, Promise<PackMemoryModelBinding[]>>();
  /** Lazily assembled once — BUILTIN_PACKS is a module constant. */
  private builtins?: PackMemoryModelBinding[];

  constructor(private readonly surreal: SurrealService) {}

  async installedMemoryModels(companyId: string): Promise<PackMemoryModelBinding[]> {
    const builtins = this.builtinBindings();
    const stored = await this.storedMemoryModels(companyId);
    // Fast path — with no builtin declaring a memoryModel (the state of the
    // world while code_memory declares none) this returns the stored array
    // untouched: byte-identical to the pre-union behavior.
    if (builtins.length === 0) return stored;
    // Precedence: an installed row with a builtin's packId is impossible by
    // construction (DomainPackInstallService rejects builtin ids at install),
    // so a duplicate here means a corrupted or hand-written row — the
    // in-process builtin wins and the row is skipped, loudly.
    const builtinIds = new Set(builtins.map((b) => b.packId));
    const deduped = stored.filter((b) => {
      if (!builtinIds.has(b.packId)) return true;
      this.logger.warn(
        `pack ${b.packId}: stored domain_pack row shadows a builtin pack id — skipped (builtin manifest wins)`,
      );
      return false;
    });
    return [...builtins, ...deduped];
  }

  /** The per-tenant leg: active domain_pack rows, cached + deduped. */
  private async storedMemoryModels(companyId: string): Promise<PackMemoryModelBinding[]> {
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
          `memory model load failed for ${companyId} (${(e as Error).message}) — serving builtin pack memory models only`,
        );
        return [] as PackMemoryModelBinding[];
      })
      .finally(() => this.inFlight.delete(companyId));
    this.inFlight.set(companyId, load);
    return load;
  }

  /**
   * The builtin leg: BUILTIN_PACKS manifests → validated bindings, via the
   * SAME defensive toBinding path stored rows go through. Redundant with the
   * module-load validation (assembleSeed runs validatePack on every builtin,
   * failing the boot on a bad manifest) but kept for consistency: nothing
   * reaches a consumer half-checked, whatever its source.
   */
  private builtinBindings(): PackMemoryModelBinding[] {
    if (this.builtins) return this.builtins;
    const bindings: PackMemoryModelBinding[] = [];
    for (const pack of this.builtinSource()) {
      const binding = this.toBinding({ packId: pack.id, version: pack.version, manifest: pack });
      if (binding) bindings.push(binding);
    }
    this.builtins = bindings;
    return bindings;
  }

  /** Static in-process manifest source — an overridable seam for tests. */
  protected builtinSource(): DomainPackManifest[] {
    return BUILTIN_PACKS;
  }

  /** Called by DomainPackInstallService next to registry.invalidate. */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  private async loadFresh(companyId: string): Promise<PackMemoryModelBinding[]> {
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<Record<string, unknown>>(
        db,
        `SELECT packId, version, manifest
           FROM domain_pack
          WHERE status = 'active' AND manifest.memoryModel != NONE`,
      ),
    );
    const bindings: PackMemoryModelBinding[] = [];
    for (const row of rows) {
      const binding = this.toBinding(row);
      if (binding) bindings.push(binding);
    }
    return bindings;
  }

  /**
   * Row → binding, defensively: the section must still pass
   * validateMemoryModel — a manifest written by an older/newer server
   * version never reaches a consumer half-checked (PackToolsReaderService
   * toBinding mold). Serves both legs: stored domain_pack rows and the
   * builtin manifests (shaped into the same row form).
   */
  private toBinding(row: Record<string, unknown>): PackMemoryModelBinding | null {
    const manifest = row.manifest as DomainPackManifest | undefined;
    if (!manifest || manifest.memoryModel === undefined || manifest.memoryModel === null) {
      return null;
    }
    try {
      validateMemoryModel(manifest, manifest.memoryModel);
    } catch (e) {
      if (e instanceof DomainPackError) {
        this.logger.warn(
          `pack ${row.packId}: memoryModel failed validation (${e.message}) — skipped`,
        );
        return null;
      }
      throw e;
    }
    return {
      packId: String(row.packId),
      packVersion: String(row.version),
      memoryModel: manifest.memoryModel,
    };
  }
}

function ttlMs(): number {
  const v = Number(process.env.PACK_MEMORY_MODEL_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}
