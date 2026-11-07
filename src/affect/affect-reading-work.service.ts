import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows } from '../db/surreal.service';
import { workExpiry, workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type AffectTokenPayload } from '../common/harness-work-token';
import { ConsentService } from './consent.service';
import { SafetyReaderService, SAFETY_TURNS_PER_BATCH } from './safety-reader.service';
import {
  SAFETY_READER_VERSION,
  SAFETY_READING_SCHEMA,
  SAFETY_READING_SYSTEM,
  parseSafetyReading,
  safetyReadingUser,
} from './safety-reading';
import { AFFECT_INFERENCE_PURPOSE } from './affect-plane.service';
import {
  AffectReaderService,
  AFFECT_TURNS_PER_BATCH,
  type AffectBatch,
} from './affect-reader.service';
import {
  AFFECT_READER_VERSION,
  AFFECT_READING_SCHEMA,
  AFFECT_READING_SYSTEM,
  affectReadingUser,
  parseAffectReading,
} from './affect-reading';

interface EpisodeRow {
  id: unknown;
  conversationId?: string | null;
  speaker?: string | null;
  text: string;
  occurredAt: Date | string;
  scope?: string[] | null;
}

/**
 * Harness mode (#909 step 4): the affect reading handed to the connected
 * agent — the same request the server pass sends (affect-reading.ts), for
 * one person (a user-scoped caller reads only their own words; a
 * tenant-global caller has none). The submission is re-checked like the
 * server's: the quotes against the stored turns, consent, contests.
 */
@Injectable()
export class AffectReadingWorkService {
  private readonly logger = new Logger(AffectReadingWorkService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly reader: AffectReaderService,
    private readonly consents: ConsentService,
    private readonly safety: SafetyReaderService,
  ) {}

  async take(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    if (opts.userId === undefined) return null;
    if (!(await this.reader.tenantInference(companyId))) return null;
    if (!(await this.consents.isActive(companyId, opts.userId, AFFECT_INFERENCE_PURPOSE))) {
      return null;
    }
    const max = Math.max(1, Math.min(opts.max ?? AFFECT_TURNS_PER_BATCH, AFFECT_TURNS_PER_BATCH));
    const batch = await this.reader.pendingBatch(companyId, opts.userId, { maxOwn: max });
    if (!batch) return null;
    const payload: AffectTokenPayload = {
      v: 2,
      t: 'affect_reading',
      c: companyId,
      u: opts.userId,
      e: batch.turns.map((t) => [t.handle, batch.ids.get(t.handle)!, t.own ? 1 : 0]),
      n: workNonce(),
      exp: workExpiry(),
    };
    this.logger.log(`harness work taken ${companyId}: affect_reading turns=${batch.own.size}`);
    return {
      kind: 'affect_reading',
      token: mintWorkToken(payload),
      systemPrompt: AFFECT_READING_SYSTEM,
      userContent: affectReadingUser(batch.person, batch.turns),
      schema: AFFECT_READING_SCHEMA,
      items: batch.own.size,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  /** The batch a token names, rebuilt from the stored turns; a turn read since stays context. */
  private async rebuild(
    companyId: string,
    payload: AffectTokenPayload,
    readerVersion: string,
  ): Promise<{ batch: AffectBatch; stale: number }> {
    const userId = payload.u;
    if (userId === undefined) throw new BadRequestException('affect work is per person');
    const ids = payload.e.map(([, id]) => new StringRecordId(id)).filter((id) => String(id));
    const { rows, read } = await this.surreal.withCompany(companyId, async (db) => ({
      rows: await queryRows<EpisodeRow>(
        db,
        `SELECT id, conversationId, speaker, text, occurredAt, scope FROM episode
          WHERE id INSIDE $ids AND userId = $u`,
        { ids, u: userId },
      ),
      read: await queryRows<unknown>(
        db,
        `SELECT VALUE episodeId FROM affect_reading
          WHERE userId = $u AND readerVersion = $v AND episodeId INSIDE $ids`,
        { u: userId, v: readerVersion, ids },
      ),
    }));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const already = new Set(read.map(String));
    const batch: AffectBatch = {
      userId,
      person: userId,
      turns: [],
      own: new Map(),
      ids: new Map(),
    };
    let stale = 0;
    for (const [handle, id, own] of payload.e) {
      const row = byId.get(id);
      if (!row) continue;
      const occurredAt = new Date(row.occurredAt).toISOString();
      // A turn read since the batch was taken (a second reader) stays context.
      const isOwn = own === 1 && !already.has(id);
      if (own === 1 && !isOwn) stale += 1;
      batch.turns.push({
        handle,
        speaker: row.speaker ?? 'unknown',
        own: isOwn,
        text: row.text,
        occurredAt,
      });
      batch.ids.set(handle, id);
      if (isOwn) {
        batch.own.set(handle, {
          episodeId: id,
          ...(row.conversationId ? { conversationId: row.conversationId } : {}),
          occurredAt,
          scope: row.scope ?? [],
        });
      }
    }
    return { batch, stale };
  }

  async submit(companyId: string, payload: AffectTokenPayload, result: unknown): Promise<object> {
    if (payload.t === 'safety_reading') return this.submitSafety(companyId, payload, result);
    const { batch, stale } = await this.rebuild(companyId, payload, AFFECT_READER_VERSION);
    if (batch.own.size === 0) return { turns: 0, observations: 0, contested: 0, stale };
    const drafts = parseAffectReading(result, batch.turns);
    const out = await this.reader.apply(companyId, batch, { drafts, model: 'connected-agent' });
    return { ...out, stale };
  }

  /**
   * #916: the safety reading for one person — offered to the agent acting
   * for them while the tenant's operator accepted safetyMonitoring. No
   * per-person consent (the operator's basis); minors included.
   */
  async takeSafety(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    if (opts.userId === undefined) return null;
    if (!(await this.safety.tenantMonitoring(companyId))) return null;
    const max = Math.max(1, Math.min(opts.max ?? SAFETY_TURNS_PER_BATCH, SAFETY_TURNS_PER_BATCH));
    const batch = await this.safety.pendingBatch(companyId, opts.userId, max);
    if (!batch) return null;
    const payload: AffectTokenPayload = {
      v: 2,
      t: 'safety_reading',
      c: companyId,
      u: opts.userId,
      e: batch.turns.map((t) => [t.handle, batch.ids.get(t.handle)!, t.own ? 1 : 0]),
      n: workNonce(),
      exp: workExpiry(),
    };
    this.logger.log(`harness work taken ${companyId}: safety_reading turns=${batch.own.size}`);
    return {
      kind: 'safety_reading',
      token: mintWorkToken(payload),
      systemPrompt: SAFETY_READING_SYSTEM,
      userContent: safetyReadingUser(batch.person, batch.turns),
      schema: SAFETY_READING_SCHEMA,
      items: batch.own.size,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  private async submitSafety(
    companyId: string,
    payload: AffectTokenPayload,
    result: unknown,
  ): Promise<object> {
    const { batch, stale } = await this.rebuild(companyId, payload, SAFETY_READER_VERSION);
    if (batch.own.size === 0) return { turns: 0, signals: 0, urgent: 0, stale };
    const drafts = parseSafetyReading(result, batch.turns);
    const out = await this.safety.apply(companyId, batch, { drafts, model: 'connected-agent' });
    return { ...out, stale };
  }
}
