import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { detectLanguage } from '../ai/locale/language-detector';
import { redactPiiWithReport } from './ingest-utils';
import { scopeForUser } from '../auth/scope-tags';
import { sanitizeIngestText } from '../common/text-sanitizer';
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
