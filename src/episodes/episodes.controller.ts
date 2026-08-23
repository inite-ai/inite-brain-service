import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  BadRequestException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { envFlagEnabled } from '../common/env-validation';
import {
  EpisodeReadStoreService,
  type EpisodePageRow,
} from './episode-read-store.service';
import {
  EpisodeSubscriptionService,
  type EpisodeSubscriptionRow,
} from './episode-subscription.service';

/**
 * Public episodes API (raw-substrate driver v1, surface 1 —
 * docs/roadmap/raw-substrate-driver-2026-08.md): the L0 substrate as a
 * contract, so any service can build its own projection without
 * speaking SurrealQL to our database.
 *
 * Gated by EPISODES_API_ENABLED (default off → 404, indistinguishable
 * from an absent route). PII fence follows the read-lane precedent:
 * callers without brain:read_pii see only rows whose piiClass is
 * empty — same predicate the episodic/segment lanes and agent-qa grep
 * apply, one implementation (the port's shared gate).
 */

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
/** Internal page size of the NDJSON export loop. */
const EXPORT_CHUNK = 500;

interface EpisodeListQuery {
  conversationId?: string;
  speaker?: string;
  since?: string;
  until?: string;
  /**
   * End-user scope key (migration 0055). Fail-closed like the fact read
   * path: omitted → tenant-global turns only; with one → global + that
   * user's. Without this the raw substrate served every user's personal
   * verbatim to any brain:read key (audit W1, finding #14).
   */
  userId?: string;
  limit?: string;
  cursor?: string;
}

/** Opaque keyset cursor: base64url of {t: occurredAtIso, id}. */
function encodeCursor(row: EpisodePageRow): string {
  return Buffer.from(
    JSON.stringify({ t: toIso(row.occurredAt), id: String(row.id) }),
  ).toString('base64url');
}

function decodeCursor(
  raw: string,
): { occurredAtIso: string; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as { t?: string; id?: string };
    if (!parsed.t || !parsed.id) throw new Error('missing fields');
    return { occurredAtIso: parsed.t, id: parsed.id };
  } catch {
    throw new BadRequestException('cursor is not a valid episodes cursor');
  }
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Wire shape: record id stringified, datetimes normalized to ISO. */
function toWire(row: EpisodePageRow): Record<string, unknown> {
  return {
    id: String(row.id),
    kind: row.kind,
    ...(row.conversationId !== undefined
      ? { conversationId: row.conversationId }
      : {}),
    messageId: row.messageId,
    ...(row.speaker !== undefined ? { speaker: row.speaker } : {}),
    ...(row.addressee !== undefined ? { addressee: row.addressee } : {}),
    text: row.text,
    ...(row.piiClass !== undefined ? { piiClass: row.piiClass } : {}),
    occurredAt: toIso(row.occurredAt),
    recordedAt: toIso(row.recordedAt),
    ...(row.lang !== undefined ? { lang: row.lang } : {}),
    source: row.source,
  };
}

function parseIsoOrThrow(name: string, v?: string): string | undefined {
  if (v === undefined) return undefined;
  if (Number.isNaN(Date.parse(v))) {
    throw new BadRequestException(`${name} must be an ISO date-time`);
  }
  return v;
}

@Controller('v1/episodes')
@UseGuards(ApiKeyGuard)
export class EpisodesController {
  constructor(
    private readonly episodes: EpisodeReadStoreService,
    private readonly subscriptions: EpisodeSubscriptionService,
  ) {}

  private assertEnabled(): void {
    if (!envFlagEnabled(process.env.EPISODES_API_ENABLED)) {
      throw new NotFoundException();
    }
  }

  @Get()
  @RequireScopes('brain:read')
  @PolicyAction('rest.episodes.list')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() q: EpisodeListQuery,
  ): Promise<{ episodes: Array<Record<string, unknown>>; nextCursor?: string }> {
    this.assertEnabled();
    const limitRaw = q.limit !== undefined ? parseInt(q.limit, 10) : DEFAULT_PAGE;
    if (!Number.isFinite(limitRaw) || limitRaw < 1) {
      throw new BadRequestException(`limit must be 1..${MAX_PAGE}`);
    }
    const limit = Math.min(limitRaw, MAX_PAGE);
    const rows = await this.episodes.page({
      companyId: req.brainAuth.companyId,
      includePii: req.brainAuth.scopes.includes('brain:read_pii'),
      limit,
      conversationId: q.conversationId,
      speaker: q.speaker,
      sinceIso: parseIsoOrThrow('since', q.since),
      untilIso: parseIsoOrThrow('until', q.until),
      userId: q.userId,
      after: q.cursor !== undefined ? decodeCursor(q.cursor) : undefined,
    });
    const lastRow = rows[rows.length - 1];
    return {
      episodes: rows.map(toWire),
      // A full page may end exactly on the last row; the follow-up
      // request then returns [] with no cursor — offset-free and safe.
      ...(lastRow && rows.length === limit
        ? { nextCursor: encodeCursor(lastRow) }
        : {}),
    };
  }

  /**
   * Replay/export: the same filtered stream as NDJSON, one episode per
   * line, paged internally — bounded memory however large the tenant.
   */
  @Get('export')
  @RequireScopes('brain:read')
  @PolicyAction('rest.episodes.export')
  async export(
    @Req() req: AuthenticatedRequest,
    @Query() q: EpisodeListQuery,
    @Res() res: Response,
  ): Promise<void> {
    this.assertEnabled();
    const base = {
      companyId: req.brainAuth.companyId,
      includePii: req.brainAuth.scopes.includes('brain:read_pii'),
      limit: EXPORT_CHUNK,
      conversationId: q.conversationId,
      speaker: q.speaker,
      sinceIso: parseIsoOrThrow('since', q.since),
      untilIso: parseIsoOrThrow('until', q.until),
      userId: q.userId,
    };
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="episodes.ndjson"');
    let after: { occurredAtIso: string; id: string } | undefined;
    for (;;) {
      const rows = await this.episodes.page({ ...base, after });
      for (const row of rows) {
        res.write(`${JSON.stringify(toWire(row))}\n`);
      }
      if (rows.length < EXPORT_CHUNK) break;
      const last = rows[rows.length - 1];
      if (!last) break; // rows non-empty here; guard satisfies the checker
      after = { occurredAtIso: toIso(last.occurredAt), id: String(last.id) };
    }
    res.end();
  }

  // ── Surface 4: new-episode webhook subscriptions ───────────────────
  // Own flag (EPISODE_SUBSCRIPTIONS_ENABLED): pushing outbound traffic
  // is a bigger operational decision than serving reads.

  private assertSubscriptionsEnabled(): void {
    if (!EpisodeSubscriptionService.enabled()) {
      throw new NotFoundException();
    }
  }

  @Post('subscriptions')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.episodes.subscribe')
  async subscribe(
    @Req() req: AuthenticatedRequest,
    @Body() body: { url?: string } = {},
  ): Promise<{ id: string; secret: string; watermark: string }> {
    this.assertSubscriptionsEnabled();
    const url = body.url?.trim() ?? '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('url must be a valid absolute URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException('url must be http(s)');
    }
    // The secret in this response is shown exactly once — store it.
    return this.subscriptions.create(req.brainAuth.companyId, url);
  }

  @Get('subscriptions')
  @RequireScopes('brain:read')
  @PolicyAction('rest.episodes.subscriptions')
  async listSubscriptions(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ subscriptions: EpisodeSubscriptionRow[] }> {
    this.assertSubscriptionsEnabled();
    return {
      subscriptions: await this.subscriptions.list(req.brainAuth.companyId),
    };
  }

  @Delete('subscriptions/:id')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.episodes.unsubscribe')
  async unsubscribe(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    this.assertSubscriptionsEnabled();
    if (!/^episode_subscription:[a-zA-Z0-9⟨⟩_-]+$/.test(id)) {
      throw new BadRequestException('id must be an episode_subscription record id');
    }
    return {
      deleted: await this.subscriptions.remove(req.brainAuth.companyId, id),
    };
  }
}
