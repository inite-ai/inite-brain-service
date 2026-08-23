import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { SurrealService, queryFirst } from '../db/surreal.service';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import type { DomainPackManifest, PackSeedDocument } from '../ai/domain-packs';
import { DocumentIngestService } from './document-ingest.service';
import type { IngestDocumentDto } from './dto/ingest-document.dto';

export interface PackSeedIngestResult {
  total: number;
  ingested: number;
  deduplicated: number;
  failed: number;
}

/**
 * Pack seed documents: knowledge a pack SHIPS, fed through the NORMAL
 * document pipeline on install (kind='pack_seed', PACK_SEED_INGEST_ENABLED).
 * The install hook enqueues a pack_seed_ingest job; this service owns the
 * handler. Each seed becomes a regular document ingest, so seed facts get
 * the same dedup/provenance/conflict machinery as any connector's — and the
 * contentHash UNIQUE index (0048) makes re-runs idempotent for free: an
 * unchanged seed dedups into the existing document, a changed one is simply
 * a new document.
 */
@Injectable()
export class PackSeedIngestService implements OnModuleInit {
  private readonly logger = new Logger(PackSeedIngestService.name);

  // Seed-ingest job owner in the reindex mold: registration, enqueue, and
  // the pipeline entry it drives per seed document.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly ingest: DocumentIngestService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(
      'pack_seed_ingest',
      (ctx) => this.executeFromQueue(ctx),
      // At most SEED_MAX_DOCS synchronous ingests (LLM extraction per
      // chunk) — bounded well under the reindex batch. 10-minute lease.
      { ttlSeconds: 600, maxAttempts: 3 },
    );
  }

  /** Enqueue the seed ingest for one installed pack version. The dedupKey
   *  is version-stable, so reinstalling the same version is a no-op once
   *  the job has succeeded — upgrades (new version) enqueue fresh. */
  async enqueueForInstall(
    companyId: string,
    p: { packId: string; packVersion: string },
  ): Promise<{ enqueued: boolean }> {
    if (!this.claim) return { enqueued: false };
    const { created } = await this.claim.enqueue({
      jobType: 'pack_seed_ingest',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `pack_seed_${p.packId}_${p.packVersion}`,
      payload: { packId: p.packId, packVersion: p.packVersion },
    });
    return { enqueued: created };
  }

  /**
   * Ingest every seed document of the pack's INSTALLED manifest. Skips
   * cleanly (all-zero result) when the pack is gone, a newer install
   * superseded the queued version, or the manifest ships no seeds. One
   * poison document must not sink the batch: per-document failures are
   * counted and the rest proceed.
   */
  async runForPack(
    companyId: string,
    p: { packId: string; packVersion: string },
    abortSignal?: AbortSignal,
  ): Promise<PackSeedIngestResult> {
    const result: PackSeedIngestResult = {
      total: 0,
      ingested: 0,
      deduplicated: 0,
      failed: 0,
    };
    const seeds = await this.loadSeeds(companyId, p);
    if (!seeds) return result;
    result.total = seeds.length;

    for (const seed of seeds) {
      if (abortSignal?.aborted) {
        // A deploy mid-batch must not read as "done". Throw so the job
        // requeues; already-ingested seeds dedup on the re-run.
        throw new Error('aborted');
      }
      try {
        const r = await this.ingest.ingestDocument(
          companyId,
          this.seedDto(seed, p),
        );
        if (r.deduplicated) result.deduplicated++;
        else result.ingested++;
      } catch (err) {
        result.failed++;
        this.logger.warn(
          `seed document ${p.packId}/${seed.localId} failed for ${companyId}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `pack seeds ${p.packId}@${p.packVersion} for ${companyId}: ingested=${result.ingested} deduplicated=${result.deduplicated} failed=${result.failed}`,
    );
    return result;
  }

  /** The installed manifest's seed documents, or null on any clean skip. */
  private async loadSeeds(
    companyId: string,
    p: { packId: string; packVersion: string },
  ): Promise<PackSeedDocument[] | null> {
    const row = await this.surreal.withCompany(companyId, (db) =>
      queryFirst<{ version: unknown; manifest?: DomainPackManifest }>(
        db,
        `SELECT version, manifest FROM domain_pack WHERE packId = $packId AND status = 'active' LIMIT 1`,
        { packId: p.packId },
      ),
    );
    if (!row) {
      this.logger.log(
        `pack_seed_ingest skipped — pack ${p.packId} is not installed for ${companyId}`,
      );
      return null;
    }
    if (String(row.version) !== p.packVersion) {
      // A newer install superseded the queued version; its own job (fresh
      // dedupKey) owns the current manifest's seeds.
      this.logger.log(
        `pack_seed_ingest skipped — ${p.packId} is at v${row.version}, job was for v${p.packVersion}`,
      );
      return null;
    }
    const seeds = row.manifest?.seedDocuments;
    if (!Array.isArray(seeds) || seeds.length === 0) return null;
    return seeds;
  }

  /** Shape one seed as a normal document-pipeline ingest. */
  private seedDto(
    seed: PackSeedDocument,
    p: { packId: string; packVersion: string },
  ): IngestDocumentDto {
    return {
      kind: 'pack_seed',
      text: seed.text,
      title: seed.title,
      originUri: seed.originUri ?? `pack://${p.packId}/${seed.localId}`,
      occurredAt: seed.occurredAt ?? new Date().toISOString(),
      // recorder = connector provenance on the source_document row; the
      // commit writer stamps the INDEXER id on facts' source.recorder.
      contextRef: { vertical: seed.vertical, recorder: `pack:${p.packId}` },
      // Flat scalar keys only (sanitizeSourceMeta drops nested objects) —
      // the provenance quad makes seed-derived rows queryable for manual
      // cleanup after an uninstall.
      meta: {
        ...seed.meta,
        pack_seed: true,
        pack_id: p.packId,
        pack_version: p.packVersion,
        pack_seed_doc: seed.localId,
      },
      // Stored content keeps seeds reindexable when the NEXT pack lands.
      storeContent: true,
      mode: 'sync',
      // With DOCUMENT_MULTI_INDEXER_ENABLED off the routed selection is
      // empty and seeds ride the union generalist pass; on, the pack's
      // own indexer reads its seeds as a dedicated run.
      indexers: [p.packId],
    };
  }

  private async executeFromQueue(
    ctx: JobContext,
  ): Promise<Record<string, unknown>> {
    const packId = String(ctx.payload?.packId ?? '');
    const packVersion = String(ctx.payload?.packVersion ?? '');
    if (!packId) return { skipped: 'missing_packId' };
    const result = await this.runForPack(
      ctx.companyId,
      { packId, packVersion },
      ctx.abortSignal,
    );
    return { ...result };
  }
}
