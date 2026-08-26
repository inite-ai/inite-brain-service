import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { digestPayload } from '../common/payload-digest';
import { sanitizePackText } from '../common/text-sanitizer';
import {
  toolObservationContentEnabled,
  toolObservationsEnabled,
} from '../common/tool-observation-flags';

/**
 * ToolObservationService — the ONE write seam for tool_observation rows
 * (migration 0111): content-free evidence anchors for tool results,
 * recorded BEFORE any interpretation.
 *
 * Discipline (the MemoryOutcomeService/fact_usage idiom):
 *   * master-flag guard INSIDE the service — callers may cheaply check
 *     too, but flag-off is a no-op here regardless;
 *   * fire-and-forget on a fresh ROOT-pool connection (the caller's
 *     scoped connection returns to the pool when the request ends — a
 *     detached write must not borrow it); a failure warns, NEVER errors
 *     or slows the tool call it observes;
 *   * every stored field is capped/sanitized; args/results are stored as
 *     16-hex SHA-256 digest prefixes (payload-digest idiom, shared with
 *     — not imported from — the strategy trajectory digester), so a raw
 *     secret or PII payload never survives into the row;
 *   * contentExcerpt is the ONE opt-in exception (TOOL_OBSERVATION_
 *     CONTENT): a sanitized ≤512-char excerpt of the result text.
 *
 * This is an EVIDENCE surface (documents/facts point back at it), never
 * an advice surface — it must not touch the strategy tables.
 */

/** Tool-name clear-text cap (a function identifier, not free text). */
export const TOOL_OBSERVATION_TOOL_CAP = 80;

/** Cap for opaque id fields (requestId / packId / installId). */
export const TOOL_OBSERVATION_ID_CAP = 128;

/** Opt-in content excerpt cap (chars). */
export const TOOL_OBSERVATION_EXCERPT_CAP = 512;

/** Ref format the ingest path accepts: `tool_observation:<id>`. */
export const TOOL_OBSERVATION_REF_PREFIX = 'tool_observation:';

export interface ToolObservationInput {
  tool: string;
  /** Raw call args — digested, never stored. */
  args?: unknown;
  /** Raw result — digested, never stored (excerpt is opt-in only). */
  result?: unknown;
  ok: boolean;
  durationMs: number;
  requestId?: string | undefined;
  packId?: string | undefined;
  installId?: string | undefined;
  /** CONTENT-FREE by contract: ids / verdict strings only. */
  meta?: Record<string, unknown> | undefined;
}

/** Row shape handed to INSERT — exported for the unit spec. */
export interface ToolObservationRow {
  tool: string;
  argsDigest: string;
  resultDigest: string;
  ok: boolean;
  durationMs: number;
  requestId?: string;
  packId?: string;
  installId?: string;
  contentExcerpt?: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class ToolObservationService {
  private readonly logger = new Logger(ToolObservationService.name);

  constructor(private readonly surreal: SurrealService) {}

  /** Master-flag read, exposed so wiring sites share one gate. */
  enabled(): boolean {
    return toolObservationsEnabled();
  }

  /**
   * Fire-and-forget: shape the content-free row and detach the insert.
   * An observation must NEVER fail (or slow) the tool call it records.
   */
  record(companyId: string, input: ToolObservationInput): void {
    if (!toolObservationsEnabled()) return;
    const row = shapeObservationRow(input);
    void this.surreal
      .withCompany(companyId, async (db) => {
        await db.query('INSERT INTO tool_observation $row', { row });
      })
      .catch((e: Error) => {
        this.logger.warn(`tool observation insert failed (tool=${row.tool}): ${e.message}`);
      });
  }

  /**
   * Validate a `tool_observation:<id>` ref for the ingest path: the row
   * must exist in THIS tenant. Returns the content-free note material
   * (tool name + ISO timestamp) or null when the ref is unknown/foreign.
   */
  async verifyRef(
    companyId: string,
    ref: string,
  ): Promise<{ tool: string; createdAt: string } | null> {
    if (!ref.startsWith(TOOL_OBSERVATION_REF_PREFIX)) return null;
    const tail = ref.slice(TOOL_OBSERVATION_REF_PREFIX.length);
    if (tail.length === 0) return null;
    let row: { tool: string; createdAt: Date | string } | null;
    try {
      row = await this.surreal.withCompany(companyId, async (db) => {
        // Table pinned via type::record('tool_observation', tail): a ref
        // can never be pointed at another table's rows.
        const [rows] = await db.query<[Array<{ tool: string; createdAt: Date | string }>]>(
          `SELECT tool, createdAt FROM tool_observation
            WHERE id = type::record('tool_observation', $tail) LIMIT 1`,
          { tail },
        );
        return (rows as Array<{ tool: string; createdAt: Date | string }>)?.[0] ?? null;
      });
    } catch {
      // Malformed tail (type::record rejects it) reads as "no such row".
      return null;
    }
    if (!row || typeof row.tool !== 'string') return null;
    return { tool: row.tool, createdAt: new Date(row.createdAt).toISOString() };
  }
}

/**
 * Pure row shaper — exported for the content-free unit spec. Digests the
 * payloads, caps every clear-text field, and includes contentExcerpt
 * ONLY under the opt-in flag.
 */
export function shapeObservationRow(input: ToolObservationInput): ToolObservationRow {
  const row: ToolObservationRow = {
    tool: sanitizePackText(input.tool, TOOL_OBSERVATION_TOOL_CAP),
    argsDigest: digestPayload(input.args),
    resultDigest: digestPayload(input.result),
    ok: input.ok === true,
    durationMs: boundedDuration(input.durationMs),
  };
  if (input.requestId !== undefined) {
    row.requestId = sanitizePackText(input.requestId, TOOL_OBSERVATION_ID_CAP);
  }
  if (input.packId !== undefined) {
    row.packId = sanitizePackText(input.packId, TOOL_OBSERVATION_ID_CAP);
  }
  if (input.installId !== undefined) {
    row.installId = sanitizePackText(input.installId, TOOL_OBSERVATION_ID_CAP);
  }
  if (input.meta !== undefined) row.meta = input.meta;
  if (toolObservationContentEnabled() && input.result !== undefined) {
    const text = typeof input.result === 'string' ? input.result : JSON.stringify(input.result);
    const excerpt = sanitizePackText(text ?? '', TOOL_OBSERVATION_EXCERPT_CAP);
    if (excerpt.length > 0) row.contentExcerpt = excerpt;
  }
  return row;
}

/** durationMs is an int column — clamp to a sane non-negative integer. */
function boundedDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), 86_400_000);
}
