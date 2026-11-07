import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows } from '../db/surreal.service';
import {
  chatCallParams,
  chatModel,
  createOpenAiClient,
  offlineServiceTier,
} from '../ai/openai-client';
import { serverModelsRefused } from '../common/extraction-source';
import { currentAffectInference } from '../ai/domain-packs/modality-consent';
import type { PackAffectInference } from '../ai/domain-packs/manifest';
import { USER_ENTITY_VERTICAL, userEntityKey } from '../ingest/user-entity';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService } from '../jobs/worker-loop.service';
import { ConsentService } from './consent.service';
import { AFFECT_INFERENCE_PURPOSE, affectStatementHash } from './affect-plane.service';
import {
  AFFECT_READER_VERSION,
  AFFECT_READING_SCHEMA,
  AFFECT_READING_SYSTEM,
  affectReadingUser,
  parseAffectReading,
  type AffectObservationDraft,
  type AffectTurn,
} from './affect-reading';

/** OWN turns one reading covers; the context around them rides along. */
export const AFFECT_TURNS_PER_BATCH = 12;
/** Context turns before the first OWN turn of a batch. */
const CONTEXT_BEFORE = 4;
/** Batches one tenant pass reads per consenting person. */
const BATCHES_PER_PERSON = 10;
/** Visible output cap of one reading: a few observations. */
const READING_VISIBLE_CAP = 1200;
/** Window that coalesces reading requests into one job. */
const SCHEDULE_WINDOW_MS = 10 * 60_000;

/** A batch of the person's unread turns, ready to be read. */
export interface AffectBatch {
  userId: string;
  person: string;
  turns: AffectTurn[];
  /** handle → episode id, conversation id, occurredAt, scope tags, for the OWN turns. */
  own: Map<string, OwnTurn>;
  /** handle → episode id, for every turn (context included). */
  ids: Map<string, string>;
}

/** An OWN turn's coordinates: what an observation of it cites and inherits. */
export interface OwnTurn {
  episodeId: string;
  conversationId?: string;
  occurredAt: string;
  /** The turn's scope tags (0093) — an observation sits behind the same fence. */
  scope: string[];
}

interface EpisodeRow {
  id: unknown;
  conversationId?: string | null;
  speaker?: string | null;
  text: string;
  occurredAt: Date | string;
  scope?: string[] | null;
}

/**
 * The affect reader (#909 step 4): infers how a person seemed to feel from
 * their own words, for a tenant whose operator accepted a pack's
 * `affectInference` declaration and a person who gave their own consent
 * (purpose `affect_inference`). Every row it writes is an observation at a
 * time, citing the exact words (0188) — never a trait, never a state.
 *
 * Two readers, one request (affect-reading.ts): the server pass below with
 * the tenant's chat model, and in harness mode the connected agent
 * (AffectReadingWorkService). Either way the answer goes through
 * parseAffectReading and `apply`, which re-checks consent and drops a
 * reading the person contested.
 */
@Injectable()
export class AffectReaderService implements OnModuleInit {
  private readonly logger = new Logger(AffectReaderService.name);
  private readonly openai: ReturnType<typeof createOpenAiClient>;
  private readonly model: string;

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly consents: ConsentService,
    configService: ConfigService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {
    this.openai = createOpenAiClient(configService);
    this.model = chatModel(configService);
  }

  onModuleInit(): void {
    this.workerLoop?.register('read_affect', (ctx) => this.runTenant(ctx.companyId), {
      ttlSeconds: 900,
      maxAttempts: 2,
    });
  }

  /** Ask for a reading pass; requests inside one window are one job. */
  async schedule(companyId: string): Promise<void> {
    if (!this.claim) return;
    const at = Math.ceil(Date.now() / SCHEDULE_WINDOW_MS) * SCHEDULE_WINDOW_MS;
    await this.claim.enqueue({
      jobType: 'read_affect',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `affect_${at}`,
      payload: {},
      visibleAfter: new Date(at),
    });
  }

  /** The inference the tenant's operator consented to, or null. */
  async tenantInference(companyId: string): Promise<PackAffectInference | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<Record<string, unknown>>(
        db,
        `SELECT manifest, acceptedModalities, acceptedModalitiesChecksum FROM domain_pack`,
      );
      return currentAffectInference(rows);
    });
  }

  /** The tenant pass: retention sweep, then every consenting person's unread turns. */
  async runTenant(companyId: string): Promise<Record<string, unknown>> {
    const inference = await this.tenantInference(companyId);
    if (!inference) return { skipped: 'no affect inference declared and accepted' };
    const swept = await this.sweep(companyId, inference.retentionDays);
    // Harness mode: the connected agent reads (take_memory_work, affect_reading).
    if (serverModelsRefused() || !this.openai) return { swept, read: 0 };
    let observations = 0;
    let turns = 0;
    for (const userId of await this.consentingUsers(companyId)) {
      // A grant that does not count (a minor's own, #916) buys no reading.
      if (!(await this.consents.isActive(companyId, userId, AFFECT_INFERENCE_PURPOSE))) continue;
      for (let i = 0; i < BATCHES_PER_PERSON; i++) {
        const batch = await this.pendingBatch(companyId, userId, {
          maxOwn: AFFECT_TURNS_PER_BATCH,
        });
        if (!batch) break;
        const drafts = await this.callModel(batch);
        if (drafts === null) break;
        const r = await this.apply(companyId, batch, { drafts, model: this.model });
        observations += r.observations;
        turns += r.turns;
      }
    }
    this.logger.log(
      `affect pass ${companyId}: turns=${turns} observations=${observations} swept=${swept}`,
    );
    return { swept, turns, observations };
  }

  /** People holding a live `affect_inference` consent. */
  async consentingUsers(companyId: string): Promise<string[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<string>(
        db,
        `SELECT VALUE userId FROM consent_record
          WHERE purpose = $p AND revokedAt IS NONE`,
        { p: AFFECT_INFERENCE_PURPOSE },
      );
      return [...new Set(rows)];
    });
  }

  /**
   * The person's earliest conversation unread by `readerVersion` (the
   * affect reader's by default; the safety reader keeps its own cursor in
   * the same table): up to `maxOwn` of their unread turns in it, with the turns just before them as context. The
   * person's turns are those spoken as them — their user entity's name or
   * ref (`user:<id>`); a turn spoken by anyone else is context only.
   */
  async pendingBatch(
    companyId: string,
    userId: string,
    opts: { maxOwn: number; readerVersion?: string | undefined },
  ): Promise<AffectBatch | null> {
    const { maxOwn } = opts;
    const readerVersion = opts.readerVersion ?? AFFECT_READER_VERSION;
    return this.surreal.withCompany(companyId, async (db) => {
      const name = (
        await queryRows<string>(
          db,
          `SELECT VALUE entity.canonicalName FROM entity_external_ref WHERE key = $key LIMIT 1`,
          { key: userEntityKey(userId) },
        )
      )[0];
      const labels = [...new Set([name, `${USER_ENTITY_VERTICAL}:${userId}`, userId])].filter(
        (l): l is string => typeof l === 'string' && l.length > 0,
      );
      const read = await queryRows<unknown>(
        db,
        `SELECT VALUE episodeId FROM affect_reading WHERE userId = $u AND readerVersion = $v`,
        { u: userId, v: readerVersion },
      );
      const readIds = read.map((id) => new StringRecordId(String(id)));
      const first = (
        await queryRows<EpisodeRow>(
          db,
          `SELECT id, conversationId, occurredAt FROM episode
            WHERE userId = $u AND kind = 'turn' AND speaker INSIDE $labels
              AND id NOTINSIDE $read
            ORDER BY occurredAt ASC LIMIT 1`,
          { u: userId, labels, read: readIds },
        )
      )[0];
      if (!first) return null;
      const conversation = await queryRows<EpisodeRow>(
        db,
        `SELECT id, conversationId, speaker, text, occurredAt, scope FROM episode
          WHERE userId = $u AND kind = 'turn' AND conversationId = $c
          ORDER BY occurredAt ASC LIMIT 400`,
        { u: userId, c: first.conversationId ?? undefined },
      );
      const readSet = new Set(read.map(String));
      const startAt = conversation.findIndex((e) => String(e.id) === String(first.id));
      const from = Math.max(0, startAt - CONTEXT_BEFORE);
      const turns: AffectTurn[] = [];
      const own = new Map<string, OwnTurn>();
      const ids = new Map<string, string>();
      let ownCount = 0;
      for (const e of conversation.slice(from)) {
        const isOwn =
          labels.includes(e.speaker ?? '') && !readSet.has(String(e.id)) && ownCount < maxOwn;
        if (!isOwn && ownCount >= maxOwn) break;
        const handle = `t${turns.length + 1}`;
        const occurredAt = iso(e.occurredAt);
        turns.push({
          handle,
          speaker: e.speaker ?? 'unknown',
          own: isOwn,
          text: e.text,
          occurredAt,
        });
        ids.set(handle, String(e.id));
        if (isOwn) {
          ownCount += 1;
          own.set(handle, {
            episodeId: String(e.id),
            ...(e.conversationId ? { conversationId: e.conversationId } : {}),
            occurredAt,
            scope: e.scope ?? [],
          });
        }
      }
      if (own.size === 0) return null;
      return { userId, person: name ?? userId, turns, own, ids };
    });
  }

  /**
   * Write a reading: consent re-checked (it may have been withdrawn while
   * the model read), contested readings dropped, every OWN turn marked
   * read whether or not it yielded anything.
   */
  async apply(
    companyId: string,
    batch: AffectBatch,
    reading: { drafts: AffectObservationDraft[]; model: string | undefined },
  ): Promise<{ turns: number; observations: number; contested: number }> {
    if (!(await this.consents.isActive(companyId, batch.userId, AFFECT_INFERENCE_PURPOSE))) {
      return { turns: 0, observations: 0, contested: 0 };
    }
    const { drafts, model } = reading;
    return this.surreal.withCompany(companyId, async (db) => {
      const contestedHashes = new Set(
        await queryRows<string>(
          db,
          `SELECT VALUE statementHash FROM affect_contest WHERE userId = $u`,
          { u: batch.userId },
        ),
      );
      const kept = drafts.filter((d) => !contestedHashes.has(affectStatementHash(d.quote)));
      const rows = kept.map((d) => {
        const turn = batch.own.get(d.handle)!;
        return {
          userId: batch.userId,
          episodeId: new StringRecordId(turn.episodeId),
          ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
          scope: turn.scope,
          observedAt: new Date(turn.occurredAt),
          valence: d.valence,
          label: d.label,
          ...(d.target ? { target: d.target } : {}),
          quote: d.quote,
          spanStart: d.spanStart,
          spanEnd: d.spanEnd,
          confidence: d.confidence,
          modality: 'text',
          readerVersion: AFFECT_READER_VERSION,
          ...(model ? { model } : {}),
        };
      });
      const perTurn = new Map<string, number>();
      for (const d of kept) perTurn.set(d.handle, (perTurn.get(d.handle) ?? 0) + 1);
      const marks = [...batch.own.entries()].map(([handle, t]) => ({
        userId: batch.userId,
        episodeId: new StringRecordId(t.episodeId),
        readerVersion: AFFECT_READER_VERSION,
        observations: perTurn.get(handle) ?? 0,
      }));
      if (rows.length > 0) await db.query(`INSERT INTO affect_observation $rows`, { rows });
      await db.query(`INSERT IGNORE INTO affect_reading $marks`, { marks });
      return {
        turns: marks.length,
        observations: rows.length,
        contested: drafts.length - kept.length,
      };
    });
  }

  /** Retention: observations older than the consented window are deleted. */
  async sweep(companyId: string, retentionDays: number): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [, rows] = await db.query<[unknown, unknown[]]>(
        `LET $old = (SELECT VALUE id FROM affect_observation
           WHERE observedAt < time::now() - type::duration($d));
         DELETE $old RETURN BEFORE;`,
        { d: `${String(retentionDays)}d` },
      );
      return (rows ?? []).length;
    });
  }

  /** ONE strict-schema call; null = degrade (the turns stay unread). */
  private async callModel(batch: AffectBatch): Promise<AffectObservationDraft[] | null> {
    try {
      const res = await this.openai!.chat.completions.create({
        model: this.model,
        ...chatCallParams(this.model, {
          tier: offlineServiceTier(),
          temperature: 0,
          visibleCap: READING_VISIBLE_CAP,
        }),
        messages: [
          { role: 'system', content: AFFECT_READING_SYSTEM },
          { role: 'user', content: affectReadingUser(batch.person, batch.turns) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'affect_reading', strict: true, schema: AFFECT_READING_SCHEMA },
        },
      });
      const content = res.choices[0]?.message?.content;
      if (!content) return null;
      return parseAffectReading(JSON.parse(content), batch.turns);
    } catch (e) {
      this.logger.warn(`affect reading failed: ${(e as Error).message}`);
      return null;
    }
  }
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
