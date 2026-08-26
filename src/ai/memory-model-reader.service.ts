import { Injectable, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { LRUCache } from '../common/lru-cache';
import {
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
 * Read side of pack-declared memory models: which active packs declare a
 * memoryModel section for this tenant (PackToolsReaderService mold —
 * LRU+TTL cache with in-flight dedupe). Contract-only for now: the
 * perception/episodization consumers arrive in sibling increments and
 * will sit on hot paths, hence the cache from day one. Fail-open to []
 * on read errors — a domain_pack hiccup must not take down a consumer;
 * models reappear on the next load. NO consent gate by design: a
 * memoryModel is declarative data with zero egress (see the decision
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

  constructor(private readonly surreal: SurrealService) {}

  async installedMemoryModels(companyId: string): Promise<PackMemoryModelBinding[]> {
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
          `memory model load failed for ${companyId} (${(e as Error).message}) — serving no pack memory models`,
        );
        return [] as PackMemoryModelBinding[];
      })
      .finally(() => this.inFlight.delete(companyId));
    this.inFlight.set(companyId, load);
    return load;
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
   * Row → binding, defensively: the stored section must still pass
   * validateMemoryModel — a manifest written by an older/newer server
   * version never reaches a consumer half-checked (PackToolsReaderService
   * toBinding mold).
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
          `pack ${row.packId}: stored memoryModel failed validation (${e.message}) — skipped`,
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
