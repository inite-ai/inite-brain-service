import { Injectable, Logger } from '@nestjs/common';
import { sourceLinkedEnabled, sourceLinkedPerQuery } from '../common/source-plane-flags';
import { ToolObservationService } from '../outcomes/tool-observation.service';
import type { ConnectorCtx, LinkedHit } from './connector';
import { SourceConnectionService } from './source-connection.service';

/**
 * The linked lane (W7): a source that keeps its own index, asked at
 * query time.
 *
 * Everything else in this plane COPIES — it walks a source, catalogues
 * what is there, fetches what changed and commits it through the doors.
 * That is the right trade for a wiki and the wrong one for a ticket
 * system with a million rows and a search engine of its own. A
 * connection in `mode: 'linked'` is never walked and never catalogued:
 * the brain asks the source its own question and gets back what the
 * source thinks the answer is.
 *
 * What makes the answer usable rather than hearsay is the same thing
 * that makes an outside answer usable here: **it is anchored**. Every call
 * writes a `tool_observation` (0111) — content-free, digested, the row
 * a document and then a fact can point back at — and the hits carry its
 * ref. A hit whose observation could not be written is NOT served: an
 * unattributable claim is worse than a missing one, and the lane would
 * rather return nothing.
 *
 * Bounds, because this is a network call on the query path: one round
 * per connection, `k` capped, a hard deadline, and every failure
 * swallowed into a named `degraded` entry rather than a failed search.
 */
export interface LinkedResult {
  connectionId: string;
  connector: string;
  /** `tool_observation:<id>` — what a document made of these hits cites. */
  observationRef: string;
  hits: LinkedHit[];
}

export interface LinkedLaneOutcome {
  results: LinkedResult[];
  /** Connections that could not answer, by name — never a silent zero. */
  degraded: Array<{ connectionId: string; reason: string }>;
}

const SNIPPET_CAP = 600;
const TITLE_CAP = 300;
const DEADLINE_MS = 8_000;

@Injectable()
export class SourceLinkedService {
  private readonly logger = new Logger(SourceLinkedService.name);

  constructor(
    private readonly connections: SourceConnectionService,
    private readonly observations: ToolObservationService,
  ) {}

  enabled(): boolean {
    return sourceLinkedEnabled();
  }

  /**
   * Ask every linked connection. Never throws: a lane that can fail a
   * search is a lane an operator turns off.
   */
  async search(companyId: string, query: string, k: number): Promise<LinkedLaneOutcome> {
    const out: LinkedLaneOutcome = { results: [], degraded: [] };
    if (!this.enabled() || query.trim().length === 0) return out;
    let rows;
    try {
      rows = await this.connections.linked(companyId);
    } catch (e) {
      this.logger.warn(`linked connections read for ${companyId} failed: ${(e as Error).message}`);
      return out;
    }
    const limit = Math.min(Math.max(1, k), sourceLinkedPerQuery());
    for (const row of rows) {
      const connectionId = String(row.id);
      try {
        const result = await this.ask({ companyId, connectionId, row, query, k: limit });
        if (result) out.results.push(result);
      } catch (e) {
        const reason = (e as Error).message ?? String(e);
        out.degraded.push({ connectionId, reason });
        this.logger.warn(`linked search ${connectionId} failed: ${reason}`);
      }
    }
    return out;
  }

  private async ask(p: {
    companyId: string;
    connectionId: string;
    row: Awaited<ReturnType<SourceConnectionService['linked']>>[number];
    query: string;
    k: number;
  }): Promise<LinkedResult | null> {
    const connector = this.connections.resolveConnector(p.row);
    if (!connector) throw new Error(this.connections.connectorUnavailable(p.row));
    if (typeof connector.search !== 'function') {
      throw new Error(`${connector.kind}: this connector cannot be asked a question (no search)`);
    }
    const credential = await this.connections.credentialFor(p.companyId, p.row);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const ctx: ConnectorCtx = {
      companyId: p.companyId,
      connection: this.connections.toConnectorView(p.row, {
        ...(await this.connections.sourceContext(p.companyId, p.row)),
        credential,
        grant: await this.connections.grantHints(p.companyId, p.row),
      }),
      signal: controller.signal,
      log: (line) => this.logger.log(`[${p.connectionId}] ${line}`),
    };
    const started = Date.now();
    let hits: LinkedHit[];
    try {
      hits = await connector.search(ctx, p.query, p.k);
    } finally {
      clearTimeout(timer);
      await connector.endRun?.(ctx).catch(() => undefined);
    }
    const capped = hits.slice(0, p.k).map(trim);
    // The anchor is written BEFORE the hits are handed anywhere: a hit
    // with no observation is not served at all.
    const observationRef = await this.observations.recordCited(p.companyId, {
      tool: `source_search.${connector.kind}`,
      args: { query: p.query, k: p.k },
      result: capped,
      ok: true,
      durationMs: Date.now() - started,
      meta: { connectionId: p.connectionId, hits: capped.length },
    });
    if (!observationRef) {
      throw new Error(
        'the linked lane needs TOOL_OBSERVATIONS_ENABLED — a hit nothing can cite is not served',
      );
    }
    return {
      connectionId: p.connectionId,
      connector: connector.kind,
      observationRef,
      hits: capped,
    };
  }
}

/** Caps applied to what a source said, before it goes anywhere. */
function trim(hit: LinkedHit): LinkedHit {
  return {
    externalId: hit.externalId.slice(0, 300),
    title: hit.title.slice(0, TITLE_CAP),
    ...(hit.originUri !== undefined ? { originUri: hit.originUri.slice(0, 1024) } : {}),
    ...(hit.snippet !== undefined ? { snippet: hit.snippet.slice(0, SNIPPET_CAP) } : {}),
    ...(hit.score !== undefined ? { score: hit.score } : {}),
    ...(hit.modifiedAt !== undefined ? { modifiedAt: hit.modifiedAt } : {}),
  };
}
