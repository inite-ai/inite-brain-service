import { providerSideFailure } from '../ai/openai-client';

/**
 * Why a group read failed, and whether reading its halves can help.
 *
 * The halving retry (extraction-batch.service.ts `readSplitting`) exists
 * for one failure: a group too long to read inside the timeout. It used
 * to split on ANY error, so a write conflict while staging an extraction
 * already paid for threw the result away and re-extracted the halves at
 * full depth, and a provider refusal (no credit, an outage) was retried
 * as ever-smaller groups that the same provider refused again (LLM spend
 * audit, 2026-10-28).
 */

/** The extraction succeeded; storing its candidates did not. */
export class ExtractionStagingError extends Error {
  constructor(override readonly cause: unknown) {
    super(`staging the extraction failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'ExtractionStagingError';
  }
}

/** Reading the halves can succeed where the whole failed. */
export function halvingCanHelp(err: unknown): boolean {
  if (err instanceof ExtractionStagingError) return false;
  // A refusal about the account or the provider, not about this text.
  if (providerSideFailure(err)) return false;
  return (err as Error | undefined)?.message !== 'aborted';
}
