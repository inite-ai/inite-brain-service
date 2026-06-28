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
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

const CODE_VERTICAL = 'code';

export class HttpDecisionSink implements DecisionSink {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      fetchImpl?: FetchLike;
    },
  ) {
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async record(candidate: DecisionCandidate): Promise<{ outcome: string }> {
    const body = {
      entityRef: { vertical: CODE_VERTICAL, id: candidate.anchor },
      predicate: candidate.kind,
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
    const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/ingest/fact`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ingest POST failed: ${res.status}`);
    }
    const json = await res.json();
    return { outcome: String(json?.outcome ?? 'UNKNOWN') };
  }
}
