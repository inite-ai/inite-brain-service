import { envFlagEnabled } from './env-flag';

/**
 * The per-credential rate of POST /v1/ingest/mention, per minute.
 *
 * A mention costs what its request does. Through the document pipeline
 * (INGEST_MENTION_VIA_DOCUMENT, production) the request stores the turn,
 * the document and its chunks (a few indexed inserts, no model and no
 * embedder: embeddings are derived later) and queues the read; the model
 * call and the bge-m3 embeddings run in the extraction batch job, whose
 * concurrency, not the request rate, bounds the CPU on the shared host.
 * So a queued mention gets THROTTLE_INGEST_LIMIT (default 600, ten a
 * second per credential: a family product sends every inbox message
 * through one machine credential). The direct path extracts inside the
 * request, so it keeps the 10/min an LLM-backed route gets.
 *
 * Read per request, so the limit follows the flag a deployment runs with.
 */
export const SYNC_MENTION_LIMIT = 10;
export const QUEUED_MENTION_DEFAULT_LIMIT = 600;

export function mentionIngestLimit(): number {
  if (!envFlagEnabled(process.env.INGEST_MENTION_VIA_DOCUMENT)) return SYNC_MENTION_LIMIT;
  const raw = parseInt(process.env.THROTTLE_INGEST_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : QUEUED_MENTION_DEFAULT_LIMIT;
}
