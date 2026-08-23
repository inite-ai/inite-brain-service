import { codeMemoryPredicateId } from '../../ai/domain-packs';
import type { DecisionCandidate, DecisionSink } from './types';

/**
 * Terminal sink — POSTs each decision candidate to brain's existing
 * /v1/ingest/fact HTTP endpoint (the same IngestService.ingestFact the
 * `record_decision` MCP tool wraps). Only the extracted fact + file anchor +
 * provenance travel to the server; raw source never does.
 *
 * `fetchImpl` is injected so the request shape + anchor mapping are unit-tested
 * without a live server; it defaults to the global fetch.
 */

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const CODE_VERTICAL = 'code';
const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpDecisionSink implements DecisionSink {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      fetchImpl?: FetchLike;
      /** Per-request timeout; a hung server must not stall a CI capture hook
       *  for hours. Default 15s. */
      timeoutMs?: number;
    },
  ) {
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async record(candidate: DecisionCandidate): Promise<{ outcome: string }> {
    const body = {
      entityRef: { vertical: CODE_VERTICAL, id: candidate.anchor },
      predicate: codeMemoryPredicateId(candidate.kind),
      object: candidate.text,
      validFrom: candidate.validFrom,
      ...(candidate.confidence !== undefined
        ? { confidence: candidate.confidence }
        : {}),
      source: {
        vertical: CODE_VERTICAL,
        recorder: 'code_memory_capture',
        eventId: candidate.commit,
        ...(candidate.location ? { messageId: candidate.location } : {}),
      },
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/v1/ingest/fact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) {
        throw new Error(`ingest POST timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`ingest POST failed: ${res.status}`);
    }
    const json = await res.json();
    const outcome = (json as { outcome?: unknown })?.outcome;
    return { outcome: String(outcome ?? 'UNKNOWN') };
  }
}
