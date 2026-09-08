/**
 * The submission seam — an INTERFACE plus one HTTP implementation, so
 * the whole pipeline is unit-testable with no network.
 *
 * Two calls, both from the documented surface:
 *
 *   1. `POST /v1/ingest/document` (scope `brain:write`) stores the
 *      evidence document and, because the body names `indexers:
 *      ['code_memory']`, opens the external work slot for it.
 *   2. `POST /v1/documents/:id/candidates` (scope `indexer:write`) stages
 *      the candidates. The CLAIMLESS flow is used deliberately: this is a
 *      single-instance operator tool, and the submission itself takes the
 *      slot atomically (docs/indexer-protocol.md, "The loop"). A
 *      concurrent duplicate gets 409, which the runner reports as
 *      already-processed rather than as a failure.
 *
 * The key must carry BOTH scopes and, if it is pack-bound, be bound to
 * `code_memory` — the server's `assertKeyBoundToPack` fence.
 */
export type { CandidatePayload } from './bundle';
import type { CandidatePayload } from './bundle';

export interface IngestedDocument {
  documentId: string;
  deduplicated: boolean;
}

export interface SubmissionOutcome {
  runId: string | null;
  staged: { entities: number; facts: number; relations: number };
  dropped: Array<{ kind: string; index: number; reason: string; detail?: string }>;
  /** True when the server reported the slot was already processed (409). */
  alreadyProcessed: boolean;
}

export interface IngestDocumentInput {
  text: string;
  title: string;
  originUri: string;
  occurredAt: string;
}

/** What the runner needs from Brain. Stub it in tests. */
export interface BrainClient {
  ingestDocument(input: IngestDocumentInput): Promise<IngestedDocument>;
  submitCandidates(documentId: string, payload: CandidatePayload): Promise<SubmissionOutcome>;
}

export interface HttpBrainClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Connector identity stamped on the stored document row. */
  vertical: string;
  packId: string;
}

interface HttpResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/** Dependency-free HTTP client (global fetch, Node 18+). */
export class HttpBrainClient implements BrainClient {
  constructor(private readonly opts: HttpBrainClientOptions) {}

  async ingestDocument(input: IngestDocumentInput): Promise<IngestedDocument> {
    const res = await this.call('POST', '/v1/ingest/document', {
      kind: 'code_repository',
      text: input.text,
      title: input.title,
      originUri: input.originUri,
      occurredAt: input.occurredAt,
      storeContent: true,
      // Route this document to the code_memory external indexer only —
      // the generalist pass has nothing to add to a machine-composed
      // evidence bundle and would spend LLM budget re-reading it.
      indexers: [this.opts.packId],
      contextRef: { vertical: this.opts.vertical, recorder: 'code-repo-indexer' },
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`document ingest failed (${res.status}): ${describe(res.body)}`);
    }
    const documentId = res.body?.['documentId'];
    if (typeof documentId !== 'string') {
      throw new Error('document ingest returned no documentId');
    }
    return { documentId, deduplicated: res.body?.['deduplicated'] === true };
  }

  async submitCandidates(
    documentId: string,
    payload: CandidatePayload,
  ): Promise<SubmissionOutcome> {
    const res = await this.call(
      'POST',
      `/v1/documents/${encodeURIComponent(documentId)}/candidates`,
      payload,
    );
    if (res.status === 409) {
      return {
        runId: null,
        staged: { entities: 0, facts: 0, relations: 0 },
        dropped: [],
        alreadyProcessed: true,
      };
    }
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`candidate submission failed (${res.status}): ${describe(res.body)}`);
    }
    const staged = (res.body?.['staged'] ?? {}) as Record<string, unknown>;
    return {
      runId: typeof res.body?.['runId'] === 'string' ? (res.body['runId'] as string) : null,
      staged: {
        entities: numberOf(staged['entities']),
        facts: numberOf(staged['facts']),
        relations: numberOf(staged['relations']),
      },
      dropped: Array.isArray(res.body?.['dropped'])
        ? (res.body['dropped'] as SubmissionOutcome['dropped'])
        : [],
      alreadyProcessed: false,
    };
  }

  private async call(method: string, path: string, body: unknown): Promise<HttpResponse> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = { message: text.slice(0, 500) };
    }
    return { status: res.status, body: parsed };
  }
}

function numberOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function describe(body: Record<string, unknown> | null): string {
  const message = body?.['message'];
  if (typeof message === 'string') return message;
  return JSON.stringify(body ?? {}).slice(0, 300);
}
