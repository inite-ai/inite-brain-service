import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows } from '../db/surreal.service';
import { chatCallParams, chatModel, createOpenAiClient } from '../ai/openai-client';
import { serverModelsRefused } from '../common/model-source';
import { currentSafetyMonitoring } from '../ai/domain-packs/modality-consent';
import type { PackSafetyMonitoring } from '../ai/domain-packs/manifest';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService } from '../jobs/worker-loop.service';
import { AffectReaderService, type AffectBatch } from './affect-reader.service';
import {
  SAFETY_READER_VERSION,
  SAFETY_READING_SCHEMA,
  SAFETY_READING_SYSTEM,
  parseSafetyReading,
  safetyReadingUser,
  type RiskSignalDraft,
} from './safety-reading';

/** OWN turns one reading covers. */
export const SAFETY_TURNS_PER_BATCH = 12;
/** Batches one pass reads per person. */
const BATCHES_PER_PERSON = 10;
/** People whose turns arrived in this window are read on a pass. */
const ACTIVE_WINDOW = '7d';
const ACTIVE_PEOPLE_CAP = 500;
const READING_VISIBLE_CAP = 800;
const SCHEDULE_WINDOW_MS = 5 * 60_000;

/**
 * The safety reader (#916 step 2): reads a person's own turns for a risk
 * of suicide or self-harm (safety-reading.ts), for a tenant whose operator
 * accepted a pack's `safetyMonitoring` declaration. The basis is the
 * operator's (vital interests / a legal obligation), so unlike affect it
 * needs no per-person consent, and it reads minors too — they are who the
 * protocols protect most. Every signal quotes the person's exact words,
 * sits behind the turn's scope tags and is class `health`.
 *
 * It shares the affect reader's batching (the same unread-turn cursor
 * table, under its own reader version). Server mode: job `read_safety`,
 * scheduled with the affect pass. Harness mode: work kind `safety_reading`.
 */
@Injectable()
export class SafetyReaderService implements OnModuleInit {
  private readonly logger = new Logger(SafetyReaderService.name);
  private readonly openai: ReturnType<typeof createOpenAiClient>;
  private readonly model: string;

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly turns: AffectReaderService,
    configService: ConfigService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {
    this.openai = createOpenAiClient(configService);
    this.model = chatModel(configService);
  }

  onModuleInit(): void {
    this.workerLoop?.register('read_safety', (ctx) => this.runTenant(ctx.companyId), {
      ttlSeconds: 900,
      maxAttempts: 2,
    });
  }

  async schedule(companyId: string): Promise<void> {
    if (!this.claim) return;
    const at = Math.ceil(Date.now() / SCHEDULE_WINDOW_MS) * SCHEDULE_WINDOW_MS;
    await this.claim.enqueue({
      jobType: 'read_safety',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `safety_${at}`,
      payload: {},
      visibleAfter: new Date(at),
    });
  }

  async tenantMonitoring(companyId: string): Promise<PackSafetyMonitoring | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<Record<string, unknown>>(
        db,
        `SELECT manifest, acceptedModalities, acceptedModalitiesChecksum FROM domain_pack`,
      );
      return currentSafetyMonitoring(rows);
    });
  }

  async runTenant(companyId: string): Promise<Record<string, unknown>> {
    const monitoring = await this.tenantMonitoring(companyId);
    if (!monitoring) return { skipped: 'no safety monitoring declared and accepted' };
    const swept = await this.sweep(companyId, monitoring.retentionDays);
    if (serverModelsRefused() || !this.openai) return { swept, read: 0 };
    let signals = 0;
    let turns = 0;
    for (const userId of await this.activePeople(companyId)) {
      for (let i = 0; i < BATCHES_PER_PERSON; i++) {
        const batch = await this.pendingBatch(companyId, userId, SAFETY_TURNS_PER_BATCH);
        if (!batch) break;
        const drafts = await this.callModel(batch);
        if (drafts === null) break;
        const r = await this.apply(companyId, batch, { drafts, model: this.model });
        signals += r.signals;
        turns += r.turns;
      }
    }
    this.logger.log(`safety pass ${companyId}: turns=${turns} signals=${signals} swept=${swept}`);
    return { swept, turns, signals };
  }

  pendingBatch(companyId: string, userId: string, maxOwn: number): Promise<AffectBatch | null> {
    return this.turns.pendingBatch(companyId, userId, {
      maxOwn,
      readerVersion: SAFETY_READER_VERSION,
    });
  }

  /** People whose turns arrived recently — the ones a pass reads. */
  async activePeople(companyId: string): Promise<string[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<string>(
        db,
        `SELECT VALUE userId FROM episode
          WHERE kind = 'turn' AND userId != NONE
            AND recordedAt > time::now() - type::duration($w)
          LIMIT ${ACTIVE_PEOPLE_CAP * 20}`,
        { w: ACTIVE_WINDOW },
      );
      return [...new Set(rows)].slice(0, ACTIVE_PEOPLE_CAP);
    });
  }

  async apply(
    companyId: string,
    batch: AffectBatch,
    reading: { drafts: RiskSignalDraft[]; model: string | undefined },
  ): Promise<{ turns: number; signals: number; urgent: number }> {
    const { drafts, model } = reading;
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = drafts.map((d) => {
        const turn = batch.own.get(d.handle)!;
        return {
          userId: batch.userId,
          episodeId: new StringRecordId(turn.episodeId),
          ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
          scope: turn.scope,
          observedAt: new Date(turn.occurredAt),
          level: d.level,
          quote: d.quote,
          spanStart: d.spanStart,
          spanEnd: d.spanEnd,
          confidence: d.confidence,
          readerVersion: SAFETY_READER_VERSION,
          ...(model ? { model } : {}),
        };
      });
      const marks = [...batch.own.values()].map((t) => ({
        userId: batch.userId,
        episodeId: new StringRecordId(t.episodeId),
        readerVersion: SAFETY_READER_VERSION,
        observations: drafts.filter((d) => batch.own.get(d.handle)?.episodeId === t.episodeId)
          .length,
      }));
      if (rows.length > 0) await db.query(`INSERT INTO risk_signal $rows`, { rows });
      await db.query(`INSERT IGNORE INTO affect_reading $marks`, { marks });
      const urgent = rows.filter((r) => r.level === 'urgent').length;
      // Ids and counts only — never the words.
      if (urgent > 0) this.logger.warn(`urgent risk signal ${companyId}: count=${urgent}`);
      return { turns: marks.length, signals: rows.length, urgent };
    });
  }

  async sweep(companyId: string, retentionDays: number): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [, rows] = await db.query<[unknown, unknown[]]>(
        `LET $old = (SELECT VALUE id FROM risk_signal
           WHERE observedAt < time::now() - type::duration($d));
         DELETE $old RETURN BEFORE;`,
        { d: `${String(retentionDays)}d` },
      );
      return (rows ?? []).length;
    });
  }

  private async callModel(batch: AffectBatch): Promise<RiskSignalDraft[] | null> {
    try {
      const res = await this.openai!.chat.completions.create({
        model: this.model,
        // Not the offline (flex) tier: an urgent signal must not wait in a queue.
        ...chatCallParams(this.model, { temperature: 0, visibleCap: READING_VISIBLE_CAP }),
        messages: [
          { role: 'system', content: SAFETY_READING_SYSTEM },
          { role: 'user', content: safetyReadingUser(batch.person, batch.turns) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'safety_reading', strict: true, schema: SAFETY_READING_SCHEMA },
        },
      });
      const content = res.choices[0]?.message?.content;
      if (!content) return null;
      return parseSafetyReading(JSON.parse(content), batch.turns);
    } catch (e) {
      this.logger.warn(`safety reading failed: ${(e as Error).message}`);
      return null;
    }
  }
}
