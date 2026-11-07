import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows } from '../db/surreal.service';
import { currentVoiceAffect } from '../ai/domain-packs/modality-consent';
import type { PackVoiceAffectInference } from '../ai/domain-packs/manifest';
import { safeFetch } from '../source-plane/connectors/safe-fetch';
import { readBoundedStream } from '../evidence/processing/adapters/adapter-io';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  storageRefScheme,
  type EvidenceStorageRegistry,
} from '../evidence/storage/storage-adapter';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService } from '../jobs/worker-loop.service';
import { ConsentService } from './consent.service';

export const VOICE_AFFECT_PURPOSE = 'voice_affect_inference';
export const VOICE_AFFECT_READER_VERSION = 'voice-affect-v1';

/** Recordings one pass reads per person. */
const ASSETS_PER_PERSON = 5;
/** Longest recording sent to the service. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEADLINE_MS = 120_000;
const MAX_SEGMENTS = 200;
const SCHEDULE_WINDOW_MS = 10 * 60_000;

/** VOICE_AFFECT_URL — the operator's voice-affect service; empty = off. */
export function voiceAffectUrl(): string {
  return (process.env.VOICE_AFFECT_URL ?? '').trim();
}

/** VOICE_AFFECT_TOKEN — the bearer the service expects, when it wants one. */
function voiceAffectToken(): string {
  return (process.env.VOICE_AFFECT_TOKEN ?? '').trim();
}

export interface VoiceSegment {
  startMs: number;
  endMs: number;
  /** 0 (calm, low energy) … 1 (agitated, high energy). */
  arousal: number;
  confidence: number;
}

/**
 * The service's answer, checked: ordered, in-range segments, at most
 * MAX_SEGMENTS; anything else dropped. The contract is ours (the remote
 * parser's mould): POST { mediaType, contentBase64 } → { segments: [...] }.
 */
export function parseVoiceSegments(raw: unknown): VoiceSegment[] {
  const list = (raw as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list)) return [];
  const out: VoiceSegment[] = [];
  for (const s of list as Array<Record<string, unknown>>) {
    const n = (k: string) =>
      typeof s?.[k] === 'number' && Number.isFinite(s[k]) ? (s[k] as number) : NaN;
    const startMs = Math.round(n('startMs'));
    const endMs = Math.round(n('endMs'));
    const arousal = n('arousal');
    const confidence = n('confidence');
    if (!(startMs >= 0 && endMs > startMs)) continue;
    if (!(arousal >= 0 && arousal <= 1 && confidence >= 0 && confidence <= 1)) continue;
    out.push({ startMs, endMs, arousal, confidence });
    if (out.length >= MAX_SEGMENTS) break;
  }
  return out;
}

interface AssetRow {
  id: unknown;
  storageRef: string;
  mediaType: string;
  occurredAt: Date | string;
  scope?: string[] | null;
}

/**
 * Voice affect (#916 step 4) — high-risk under the EU AI Act. Reads a
 * person's arousal / energy from recordings of their OWN voice only when
 * every gate holds, re-checked on every pass:
 *  1. a pack's voiceAffectInference accepted by the operator, in a recorded
 *     deployment context where the AI Act allows it (never workplace /
 *     education — currentVoiceAffect);
 *  2. the person's live consent to purpose voice_affect_inference (a
 *     minor's counts only from a guardian, ConsentService.isActive);
 *  3. the person's emotion-recognition notice recorded (AI Act art. 50(3):
 *     safety_event emotion_recognition_notice_shown);
 *  4. a recording the operator marked as the person's own voice
 *     (evidence_asset.meta.speaker = 'self'), clean and readable;
 *  5. the operator's service configured (VOICE_AFFECT_URL) — brain hosts
 *     no model; the bytes go to the operator's own endpoint under the
 *     egress guard.
 * An observation is modality 'voice': arousal and a time range of the
 * recording, no words, no valence. Withdrawal erases voice observations.
 */
@Injectable()
export class VoiceAffectReaderService implements OnModuleInit {
  private readonly logger = new Logger(VoiceAffectReaderService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly consents: ConsentService,
    @Optional()
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    private readonly storage?: EvidenceStorageRegistry,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    this.workerLoop?.register('read_voice_affect', (ctx) => this.runTenant(ctx.companyId), {
      ttlSeconds: 900,
      maxAttempts: 2,
    });
    this.consents.registerRevocationHandler(VOICE_AFFECT_PURPOSE, {
      onRevoke: async (companyId, userId) => ({
        observationsDeleted: await this.eraseVoice(companyId, userId),
      }),
    });
  }

  async schedule(companyId: string): Promise<void> {
    if (!this.claim) return;
    const at = Math.ceil(Date.now() / SCHEDULE_WINDOW_MS) * SCHEDULE_WINDOW_MS;
    await this.claim.enqueue({
      jobType: 'read_voice_affect',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `voice_${at}`,
      payload: {},
      visibleAfter: new Date(at),
    });
  }

  async tenantVoice(companyId: string): Promise<PackVoiceAffectInference | null> {
    return this.surreal.withCompany(companyId, async (db) =>
      currentVoiceAffect(
        await queryRows<Record<string, unknown>>(
          db,
          `SELECT manifest, acceptedModalities, acceptedModalitiesChecksum, deploymentContext
             FROM domain_pack`,
        ),
      ),
    );
  }

  async runTenant(companyId: string): Promise<Record<string, unknown>> {
    const voice = await this.tenantVoice(companyId);
    if (!voice) return { skipped: 'no voice affect declared, accepted and allowed here' };
    const swept = await this.sweep(companyId, voice.retentionDays);
    if (!voiceAffectUrl()) return { swept, read: 0 };
    let read = 0;
    let observations = 0;
    for (const userId of await this.eligiblePeople(companyId)) {
      for (const asset of await this.unreadAssets(companyId, userId)) {
        const segments = await this.callService(asset);
        if (segments === null) break;
        observations += await this.apply(companyId, userId, { asset, segments });
        read += 1;
      }
    }
    this.logger.log(`voice affect ${companyId}: recordings=${read} observations=${observations}`);
    return { swept, read, observations };
  }

  /** People with live consent, whose grant counts, and whose notice was recorded. */
  async eligiblePeople(companyId: string): Promise<string[]> {
    const users = await this.surreal.withCompany(companyId, (db) =>
      queryRows<string>(
        db,
        `SELECT VALUE userId FROM consent_record WHERE purpose = $p AND revokedAt IS NONE`,
        { p: VOICE_AFFECT_PURPOSE },
      ),
    );
    const out: string[] = [];
    for (const userId of new Set(users)) {
      if (!(await this.consents.isActive(companyId, userId, VOICE_AFFECT_PURPOSE))) continue;
      const notice = await this.surreal.withCompany(companyId, (db) =>
        queryRows<unknown>(
          db,
          `SELECT VALUE id FROM safety_event
            WHERE userId = $u AND type = 'emotion_recognition_notice_shown' LIMIT 1`,
          { u: userId },
        ),
      );
      if (notice.length > 0) out.push(userId);
    }
    return out;
  }

  async unreadAssets(companyId: string, userId: string): Promise<AssetRow[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const read = await queryRows<unknown>(
        db,
        `SELECT VALUE assetId FROM voice_affect_reading WHERE userId = $u AND readerVersion = $v`,
        { u: userId, v: VOICE_AFFECT_READER_VERSION },
      );
      return queryRows<AssetRow>(
        db,
        `SELECT id, storageRef, mediaType, occurredAt, scope FROM evidence_asset
          WHERE userId = $u AND modality = 'audio' AND availability = 'hot'
            AND storageRef != NONE AND meta.speaker = 'self'
            AND (quarantineStatus = NONE OR quarantineStatus = 'clean')
            AND id NOTINSIDE $read
          ORDER BY occurredAt ASC LIMIT ${ASSETS_PER_PERSON}`,
        { u: userId, read: read.map((id) => new StringRecordId(String(id))) },
      );
    });
  }

  /** Write a reading: consent and notice re-checked at write; the recording marked read. */
  async apply(
    companyId: string,
    userId: string,
    reading: { asset: AssetRow; segments: VoiceSegment[] },
  ): Promise<number> {
    if (!(await this.eligiblePeople(companyId)).includes(userId)) return 0;
    const { asset, segments } = reading;
    const at = new Date(asset.occurredAt).getTime();
    const rows = segments.map((s) => ({
      userId,
      assetId: new StringRecordId(String(asset.id)),
      scope: asset.scope ?? [],
      observedAt: new Date(at + s.startMs),
      arousal: s.arousal,
      startMs: s.startMs,
      endMs: s.endMs,
      confidence: s.confidence,
      modality: 'voice',
      readerVersion: VOICE_AFFECT_READER_VERSION,
    }));
    return this.surreal.withCompany(companyId, async (db) => {
      if (rows.length > 0) await db.query(`INSERT INTO affect_observation $rows`, { rows });
      await db.query(`INSERT IGNORE INTO voice_affect_reading $mark`, {
        mark: {
          userId,
          assetId: new StringRecordId(String(asset.id)),
          readerVersion: VOICE_AFFECT_READER_VERSION,
          observations: rows.length,
        },
      });
      return rows.length;
    });
  }

  async sweep(companyId: string, retentionDays: number): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [, rows] = await db.query<[unknown, unknown[]]>(
        `LET $old = (SELECT VALUE id FROM affect_observation
           WHERE modality = 'voice' AND observedAt < time::now() - type::duration($d));
         DELETE $old RETURN BEFORE;`,
        { d: `${String(retentionDays)}d` },
      );
      return (rows ?? []).length;
    });
  }

  private async eraseVoice(companyId: string, userId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [, rows] = await db.query<[unknown, unknown[]]>(
        `LET $v = (SELECT VALUE id FROM affect_observation WHERE userId = $u AND modality = 'voice');
         DELETE $v RETURN BEFORE;`,
        { u: userId },
      );
      return (rows ?? []).length;
    });
  }

  /** ONE call to the operator's service; null = degrade (the recording stays unread). */
  private async callService(asset: AssetRow): Promise<VoiceSegment[] | null> {
    const adapter = this.storage?.get(storageRefScheme(asset.storageRef) ?? '');
    if (!adapter) return null;
    try {
      const bytes = await readBoundedStream(await adapter.get(asset.storageRef), MAX_AUDIO_BYTES);
      const token = voiceAffectToken();
      const res = await safeFetch(voiceAffectUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          mediaType: asset.mediaType,
          contentBase64: bytes.toString('base64'),
        }),
        timeoutMs: DEADLINE_MS,
      });
      if (res.status >= 400) throw new Error(`voice affect service answered ${String(res.status)}`);
      return parseVoiceSegments(JSON.parse(res.body.toString('utf8')));
    } catch (e) {
      this.logger.warn(`voice affect read failed: ${(e as Error).message}`);
      return null;
    }
  }
}
