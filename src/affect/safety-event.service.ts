import { BadRequestException, Injectable } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';

export const SAFETY_EVENT_TYPES = [
  'ai_disclosure_shown',
  'break_reminder_shown',
  'crisis_referral_shown',
  'minor_safety_setting_changed',
  'emotion_recognition_notice_shown',
] as const;
export type SafetyEventType = (typeof SAFETY_EVENT_TYPES)[number];

export interface SafetyEventWire {
  eventId: string;
  type: SafetyEventType;
  protocolVersion: string;
  resource?: string;
  at: string;
}

export interface SafetyReportRow {
  /** YYYY-MM (UTC). */
  month: string;
  type: SafetyEventType;
  count: number;
}

interface EventRow {
  id: unknown;
  type: SafetyEventType;
  protocolVersion: string;
  resource?: string | null;
  at: Date | string;
}

/**
 * What the operator's safety protocol did, per person (#916 step 2,
 * migration 0190): AI disclosure and break reminders (CA SB 243, NY GBL
 * art. 47), crisis referrals, a minor's safety setting changed, an
 * emotion-recognition notice (EU AI Act art. 50(3)). The operator's agent
 * records them; brain keeps the record and answers the report the law
 * asks for — counts by month and type, with no identifier in it.
 */
@Injectable()
export class SafetyEventService {
  constructor(private readonly surreal: SurrealService) {}

  async record(opts: {
    companyId: string;
    userId: string;
    type: string;
    protocolVersion: string;
    resource?: string | undefined;
    recordedBy?: string | undefined;
  }): Promise<SafetyEventWire> {
    if (!(SAFETY_EVENT_TYPES as readonly string[]).includes(opts.type)) {
      throw new BadRequestException(`type must be one of ${SAFETY_EVENT_TYPES.join('|')}`);
    }
    const protocolVersion = opts.protocolVersion?.trim();
    if (!protocolVersion || protocolVersion.length > 128) {
      throw new BadRequestException('protocolVersion is required (≤128 chars)');
    }
    const resource = opts.resource?.trim().slice(0, 200) || undefined;
    return this.surreal.withCompany(opts.companyId, async (db) => {
      const [rows] = await db.query<[EventRow[]]>(
        `CREATE safety_event CONTENT {
           userId: $u, type: $t, protocolVersion: $p, resource: $r, recordedBy: $by }`,
        { u: opts.userId, t: opts.type, p: protocolVersion, r: resource, by: opts.recordedBy },
      );
      return toWire(rows![0]!);
    });
  }

  async list(companyId: string, userId: string): Promise<SafetyEventWire[]> {
    return this.surreal.withCompany(companyId, async (db) =>
      (
        await queryRows<EventRow>(
          db,
          `SELECT id, type, protocolVersion, resource, at FROM safety_event
            WHERE userId = $u ORDER BY at DESC LIMIT 500`,
          { u: userId },
        )
      ).map(toWire),
    );
  }

  /** Counts by month and type in [from, to) — no person in it (SB 243 §22603). */
  async report(companyId: string, from: Date, to: Date): Promise<SafetyReportRow[]> {
    if (!(from < to)) throw new BadRequestException('from must be before to');
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<{ month: string; type: SafetyEventType; count: number }>(
        db,
        `SELECT type, time::format(at, '%Y-%m') AS month, count() AS count
           FROM safety_event WHERE at >= $from AND at < $to
          GROUP BY type, month`,
        { from, to },
      );
      return rows
        .map((r) => ({ month: r.month, type: r.type, count: r.count }))
        .sort((a, b) => a.month.localeCompare(b.month) || a.type.localeCompare(b.type));
    });
  }
}

function toWire(row: EventRow): SafetyEventWire {
  return {
    eventId: String(row.id),
    type: row.type,
    protocolVersion: row.protocolVersion,
    ...(row.resource ? { resource: row.resource } : {}),
    at: new Date(row.at).toISOString(),
  };
}
