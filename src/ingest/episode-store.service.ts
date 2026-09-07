import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { detectLanguage } from '../ai/locale/language-detector';
import { redactPiiWithReport } from './ingest-utils';
import { scopeForUser } from '../auth/scope-tags';
import { sanitizeIngestText } from '../common/text-sanitizer';
import { markConversationDirty, type SceneDirtyDb } from '../common/scene-dirty';
import { sceneScheduledMaintenanceEnabled, sceneSegmentationEnabled } from '../common/scene-flags';
import type { IngestMentionDto, KnownEntity } from './dto/ingest-mention.dto';

/**
 * L0 episode capture (EPISODE_SUBSTRATE_ENABLED — P1 of
 * docs/roadmap/memory-substrate-redesign-2026-07.md).
 *
 * Writes the verbatim (P0-redacted) dialogue turn BEFORE extraction runs, so
 * an extractor failure no longer loses the turn forever. The write is:
 *  - LLM- and embedder-free (one INSERT; embedding is derived state,
 *    backfillable from text later);
 *  - idempotent (INSERT IGNORE against the UNIQUE (conversationId,
 *    messageId) index — retries and replays are safe);
 *  - non-fatal (any failure is a warn; the fact pipeline must not depend on
 *    the substrate while it is flag-gated).
 *
 * Also the scene staleness seam (migration 0130, SCENES_SCHEDULED_MAINTENANCE,
 * default off): the same call marks the turn's conversation dirty so the
 * nightly scene pass recomposes what MOVED instead of enumerating every
 * conversation that exists. Own try/catch, own flag pair — see markSceneDirty.
 */
@Injectable()
export class EpisodeStoreService {
  private readonly logger = new Logger(EpisodeStoreService.name);

  constructor(private readonly surreal: SurrealService) {}

  isEnabled(): boolean {
    return envFlagEnabled(process.env.EPISODE_SUBSTRATE_ENABLED);
  }

  /**
   * Capture one mention as an episode. Never throws; returns the episode
   * record id (as a string) when the turn is stored — fresh insert OR
   * idempotent duplicate — and null when disabled or failed. The
   * fail-closed DECISION lives in the caller (mention-ingest under
   * EVIDENCE_FAIL_CLOSED_CAPTURE); this store stays advisory.
   *
   * Duplicate handling: INSERT IGNORE against the UNIQUE
   * (conversationId, messageId) index returns no row for an ignored
   * duplicate (the row id is server-generated, not derivable), so the
   * existing row is recovered by a fallback SELECT on the same unique
   * key. The INSERT statement itself is byte-identical to before.
   */
  async captureTurn(companyId: string, dto: IngestMentionDto): Promise<string | null> {
    if (!this.isEnabled()) return null;
    try {
      // G9 ingest sanitization (INGEST_SANITIZE_UNICODE, default off):
      // NFC-normalize + strip bidi/zero-width/control chars BEFORE
      // redaction and language detection, so the stored turn text, the
      // PII spans computed over it, and the detected language all see the
      // same de-obfuscated text. Flag off → dto.text is used verbatim
      // (byte-identical capture). Layout (\n \t) is preserved.
      const rawText = envFlagEnabled(process.env.INGEST_SANITIZE_UNICODE)
        ? sanitizeIngestText(dto.text)
        : dto.text;
      const { text, classes } = redactPiiWithReport(rawText);
      const participant = (role: string): KnownEntity | undefined =>
        dto.knownEntities?.find((k) => k.role === role);
      const nameOf = (k?: KnownEntity): string | undefined =>
        k ? (k.name ?? `${k.vertical}:${k.id}`) : undefined;
      // Deliberately NOT behind MULTILINGUAL_LANG_STAMP_CONFIDENCE_GATE:
      // episode.lang is descriptive metadata only — no read surface hard-
      // filters on it (the gate exists for knowledge_fact.lang, the input
      // of the search WHERE exclusion), and a full dialogue turn is the
      // detector's best-case input, not the short-object failure mode.
      // Revisit if an episode read path ever grows a lang filter.
      const lang = detectLanguage(rawText).language;
      const row = {
        kind: 'turn',
        conversationId: dto.contextRef.conversationId,
        messageId: this.messageIdFor(dto),
        speaker: nameOf(participant('speaker')),
        addressee: nameOf(participant('addressee')),
        text,
        piiClass: classes.length > 0 ? classes : undefined,
        occurredAt: new Date(dto.emittedAt),
        // Audit 2026-08-21 P0: the per-user scope rides the episode row —
        // every L0 read surface fences on it (fail-closed, 0055 model).
        userId: dto.userId,
        // G6 step 1: mirror it as a scope tag (0093) so the scope fence
        // and the userId fence stay in lockstep going forward.
        scope: scopeForUser(dto.userId),
        lang: lang === 'und' ? undefined : lang,
        source: {
          vertical: dto.contextRef.vertical,
          ...(dto.contextRef.eventId ? { eventId: dto.contextRef.eventId } : {}),
          ...(dto.contextRef.messageId ? { messageId: dto.contextRef.messageId } : {}),
          ...(dto.contextRef.recorder ? { recorder: dto.contextRef.recorder } : {}),
        },
      };
      return await this.surreal.withCompany(companyId, async (db) => {
        const [rows] = await db.query<[Array<{ id?: unknown }>]>(
          `INSERT IGNORE INTO episode $row`,
          {
            row,
          },
        );
        // Scene staleness trigger (migration 0130): this is the one place
        // that already knows "conversation X just received a turn", which
        // is exactly the predicate the nightly scene pass needs so it can
        // recompose what moved instead of the whole corpus. One UPSERT on a
        // primary key, and only when BOTH the scenes master flag and
        // SCENES_SCHEDULED_MAINTENANCE are on — marks must never accumulate
        // for a composer that is switched off, and with either flag off no
        // scene_dirty_conversation row is ever written.
        //
        // Marked on the duplicate path too, deliberately: an INSERT IGNORE
        // that matched an existing turn tells us nothing about whether the
        // SCENE world already covers it (a replay after a failed compose is
        // the normal case), and a redundant recompose is idempotent.
        await this.markSceneDirty(db, row.conversationId);
        const created = rows?.[0]?.id;
        if (created !== undefined && created !== null) return String(created);
        // Duplicate (INSERT IGNORE returned no row): recover the existing
        // row via the unique (conversationId, messageId) key. contextRef
        // .conversationId is OPTIONAL — an absent value is stored as NONE,
        // so the WHERE must say IS NONE, not `= $conv` (which never
        // matches NONE).
        const where =
          row.conversationId === undefined
            ? 'conversationId IS NONE AND messageId = $mid'
            : 'conversationId = $conv AND messageId = $mid';
        const [found] = await db.query<[Array<unknown>]>(
          `SELECT VALUE id FROM episode WHERE ${where} LIMIT 1`,
          {
            mid: row.messageId,
            ...(row.conversationId !== undefined ? { conv: row.conversationId } : {}),
          },
        );
        const existing = found?.[0];
        return existing !== undefined && existing !== null ? String(existing) : null;
      });
    } catch (e) {
      this.logger.warn(`episode capture failed (companyId=${companyId}): ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Mark the conversation for the nightly scene pass. Its own try/catch,
   * NOT the caller's: capture already succeeded at this point, and a mark
   * failure must not turn a stored turn into a `null` return — that return
   * is what the EVIDENCE_FAIL_CLOSED_CAPTURE path reads to reject the whole
   * mention. Worst case of a swallowed failure is a conversation whose
   * scenes are one pass stale; the operator's full rebuild still fixes it.
   *
   * A turn with no conversationId (the field is optional) has nothing to
   * mark — scenes are keyed by conversation.
   */
  private async markSceneDirty(db: SceneDirtyDb, conversationId?: string): Promise<void> {
    if (conversationId === undefined) return;
    if (!sceneSegmentationEnabled() || !sceneScheduledMaintenanceEnabled()) return;
    try {
      await markConversationDirty(db, conversationId);
    } catch (e) {
      this.logger.warn(
        `scene dirty mark failed (conversationId=${conversationId}): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Stable idempotency key: caller-provided messageId/eventId when present,
   * else a content hash — a retried mention with identical text+time maps to
   * the same episode row either way.
   */
  private messageIdFor(dto: IngestMentionDto): string {
    if (dto.contextRef.messageId) return dto.contextRef.messageId;
    if (dto.contextRef.eventId) return dto.contextRef.eventId;
    return createHash('sha256').update(`${dto.emittedAt}${dto.text}`).digest('hex').slice(0, 24);
  }
}
