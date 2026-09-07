import { Injectable, Logger } from '@nestjs/common';
import { RecordId, StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { MemoryModelReaderService } from '../ai/memory-model-reader.service';
import { ProjectionRegistryService } from '../episodes/projection-registry.service';
import {
  PACK_SCENE_PROJECTOR,
  buildPackSceneRow,
  packSceneIdTail,
  packSceneProjectionName,
  packSceneVersion,
  packStateDeltaEntry,
  swapPackSceneSlice,
} from '../episodes/pack-scene-projection';
import { packMemoryProjectionsEnabled } from '../common/pack-projection-flags';
import { envFlagEnabled } from '../common/env-validation';
import { sanitizeIngestText } from '../common/text-sanitizer';
import { redactPiiWithReport } from './ingest-utils';
import { derivePackScenes, type DerivedPackScene } from './pack-scene-derivation';
import type { IngestMentionDto } from './dto/ingest-mention.dto';
import type { PackMemoryModelBinding } from '../ai/memory-model-reader.service';

/** One pack's projection outcome for one turn (observability + tests). */
export interface TurnProjectionOutcome {
  packId: string;
  version: string;
  scenes: number;
  stateDeltas: number;
}

/**
 * The CAPTURE-PATH producer for pack memory projections (migration 0110,
 * PACK_MEMORY_PROJECTIONS_ENABLED) — the mention-origin sibling of
 * SceneCandidateWriterService.
 *
 * WHY. Until now only the DOCUMENT pipeline ever produced pack
 * projections: an external indexer submitted `scenes`/`stateDeltas`, they
 * were staged as candidates and projected at commit. For a tenant whose
 * memory arrives as MENTIONS — the primary write path for conversational
 * memory — the whole subsystem was dormant: a flag with no producer on
 * the main tract. This is that producer.
 *
 * SHAPE. Rows are the SHARED buildPackSceneRow shape, in the SHARED
 * `pack:<packId>+<fp>` world, registered in the SAME projection ledger
 * (`scenes:<packId>`) — one shape, two origins (pack-scene-projection.ts).
 * Shadow, exactly like the document origin: nothing on the serving path
 * reads memory_episode.
 *
 * COST. Per turn, with the flag on, a tenant WITHOUT packs declaring a
 * memoryModel pays one cached reader call (LRU + 30s TTL) and returns.
 * A pack that declares one pays literal substring matching over the turn
 * (no LLM, no embedding, no extra read) and — only when something
 * actually fired — ONE transaction. With the flag off nothing runs at
 * all: the env fence is the first statement.
 *
 * GDPR. A projected turn scene is bound to its L0 `episode` row by a
 * memory_episode_member edge, so the existing forget cascades (which take
 * every scene whose membership quotes an erased turn) erase it with no
 * new leg and no new migration. That binding is REQUIRED, not optional:
 * with no captured episode id there is no erasure anchor, so the producer
 * declines to project (EPISODE_SUBSTRATE_ENABLED is therefore a hard
 * prerequisite of the capture path — prod runs it on).
 *
 * FAILURE. Soft-fail by contract: the ingest response must never depend
 * on a shadow projection. Per-pack failures are warned and skipped, the
 * ledger row goes 'failed', and the caller wraps the whole call anyway.
 */
@Injectable()
export class MentionProjectionService {
  private readonly logger = new Logger(MentionProjectionService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly memoryModels: MemoryModelReaderService,
    private readonly registry: ProjectionRegistryService,
  ) {}

  async projectTurn(p: {
    companyId: string;
    dto: IngestMentionDto;
    /** The L0 episode record id — the erasure anchor (see class doc). */
    episodeId: string;
    /** Advisory state-delta subject (the turn's first extracted entity). */
    subject?: string | undefined;
  }): Promise<TurnProjectionOutcome[]> {
    // Flag fence FIRST: with PACK_MEMORY_PROJECTIONS_ENABLED off
    // (default) the capture path is byte-identical to before — no read,
    // no write, not even a cache lookup.
    if (!packMemoryProjectionsEnabled()) return [];
    if (!p.episodeId) return [];
    // Installed packs (unioned with builtins that declare a memoryModel).
    // A tenant with none exits here — nothing derived, nothing written.
    const bindings = await this.memoryModels.installedMemoryModels(p.companyId);
    if (bindings.length === 0) return [];

    const turn = redactedTurn(p.dto);
    if (turn.text.trim() === '') return [];

    const outcomes: TurnProjectionOutcome[] = [];
    for (const binding of bindings) {
      const outcome = await this.projectPack({ ...p, binding, turn });
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  /** One pack's derivation + swap; never throws (soft-fail contract). */
  private async projectPack(p: {
    companyId: string;
    dto: IngestMentionDto;
    episodeId: string;
    subject?: string | undefined;
    binding: PackMemoryModelBinding;
    turn: RedactedTurn;
  }): Promise<TurnProjectionOutcome | null> {
    const { binding } = p;
    const scenes = derivePackScenes({
      text: p.turn.text,
      model: binding.memoryModel,
      subject: p.subject,
    });
    // Nothing literal matched — the common case. No ledger row, no query.
    if (scenes.length === 0) return null;

    const version = packSceneVersion(binding.packId, binding.packVersion);
    const name = packSceneProjectionName(binding.packId);
    await this.registry.begin({
      companyId: p.companyId,
      name,
      version,
      builder: PACK_SCENE_PROJECTOR,
    });
    try {
      const written = await this.writeSlice({ ...p, version, scenes });
      await this.registry.complete({
        companyId: p.companyId,
        name,
        version,
        live: false,
        stats: { episodeId: p.episodeId, scenes: written.scenes, stateDeltas: written.stateDeltas },
      });
      return { packId: binding.packId, version, ...written };
    } catch (e) {
      await this.registry.fail({ companyId: p.companyId, name, version });
      this.logger.warn(
        `turn scene projection failed for pack ${binding.packId} on episode ${p.episodeId}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Build and swap this (turn × pack-version) slice.
   *
   * IDEMPOTENCY. Scene ids are deterministic over
   * (episodeId, version, schemaId) — one row per (turn, pack, projection
   * kind) — and the slice being replaced is EVERY declared schema's id,
   * computed in TS. So a replayed or re-ingested turn (L0 capture is
   * itself idempotent on (conversationId, messageId), so the episode id
   * is stable) converges on the same rows instead of appending, and a
   * schema that stops firing has its stale row removed by the same swap.
   * Primary-key-addressed by construction: no WHERE over an indexed
   * field, no new index, no per-turn scan of the pack world.
   */
  private async writeSlice(p: {
    companyId: string;
    dto: IngestMentionDto;
    episodeId: string;
    binding: PackMemoryModelBinding;
    version: string;
    turn: RedactedTurn;
    scenes: DerivedPackScene[];
  }): Promise<{ scenes: number; stateDeltas: number }> {
    const { dto, episodeId, binding, version } = p;
    const generation = new Date().toISOString();
    const occurredAt = new Date(dto.emittedAt);
    const conversationId = dto.contextRef.conversationId;
    const turnRef = new StringRecordId(episodeId);

    const sceneRows: Record<string, unknown>[] = [];
    const memberRows: Record<string, unknown>[] = [];
    let stateDeltas = 0;
    for (const scene of p.scenes) {
      const idTail = packSceneIdTail(episodeId, version, scene.schemaId);
      const deltas = scene.stateDeltas.map((d) =>
        packStateDeltaEntry({
          stateModelId: d.stateModelId,
          subject: d.subject,
          from: d.from,
          to: d.to,
          confidence: d.confidence,
        }),
      );
      stateDeltas += deltas.length;
      sceneRows.push(
        buildPackSceneRow({
          idTail,
          // Per-user scope (0055/0093/0117): the turn's pinned user, the
          // same value the L0 episode row carries.
          userId: dto.userId,
          piiClass: p.turn.classes,
          sceneLabel: scene.label,
          conversationIds: conversationId ? [conversationId] : [],
          occurredFrom: occurredAt,
          occurredTo: occurredAt,
          gist: scene.gist,
          confidence: scene.confidence,
          version,
          generation,
          origin: {
            episodeId: turnRef,
            packId: binding.packId,
            packVersion: binding.packVersion,
            schemaId: scene.schemaId,
          },
          stateDeltas: deltas,
        }),
      );
      memberRows.push({
        in: new RecordId('memory_episode', idTail),
        out: turnRef,
        role: 'core',
        ord: 0,
        relevance: 1,
        segmenterVersion: version,
      });
    }

    await this.surreal.withCompany(p.companyId, (db) =>
      swapPackSceneSlice(db as unknown as Surreal, {
        version,
        key: { by: 'ids', ids: declaredSliceIds(binding, episodeId, version) },
        sceneRows,
        memberRows,
      }),
    );
    return { scenes: sceneRows.length, stateDeltas };
  }
}

/**
 * Every id this (turn × pack-version) slice can own — one per DECLARED
 * sceneSchema, whether or not it fired. Deriving the full slice (instead
 * of only the rows being written) is what makes a re-ingest that matches
 * FEWER schemas leave nothing behind.
 */
function declaredSliceIds(
  binding: PackMemoryModelBinding,
  episodeId: string,
  version: string,
): RecordId[] {
  const schemas = binding.memoryModel.sceneSchemas ?? [];
  return schemas
    .filter((s) => typeof s?.id === 'string' && s.id !== '')
    .map((s) => new RecordId('memory_episode', packSceneIdTail(episodeId, version, s.id)));
}

/** The turn as the L0 episode row stores it: redacted text + PII classes. */
interface RedactedTurn {
  text: string;
  classes: string[];
}

/**
 * The turn text as the L0 episode row stores it: the same optional G9
 * sanitization, then P0 redaction — so a projected gist can never expose
 * text the captured turn itself masked, and the scene's piiClass is the
 * turn's own report (the composer's member-union fold, single member).
 */
function redactedTurn(dto: IngestMentionDto): RedactedTurn {
  if (typeof dto.text !== 'string') return { text: '', classes: [] };
  const raw = envFlagEnabled(process.env.INGEST_SANITIZE_UNICODE)
    ? sanitizeIngestText(dto.text)
    : dto.text;
  return redactPiiWithReport(raw);
}
