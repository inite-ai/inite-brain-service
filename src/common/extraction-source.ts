/**
 * Who reads captured documents (#819). `server` (default): the background
 * pass calls the configured extraction model. `harness`: the server spends
 * no model key on extraction — documents stay pending, and the connected
 * agent reads them with its own model through `take_extraction_work` /
 * `submit_extraction` (extraction-work.service.ts).
 *
 * A string setting, not an engine flag: it chooses who pays for the read,
 * not which code path a measurement sees — the harness reply goes through
 * the same grounding, staging and commit as the server's own. The one
 * reader of EXTRACTION_SOURCE; anything else is `server`.
 */
export type ExtractionSource = 'server' | 'harness';

export function extractionSource(env: NodeJS.ProcessEnv = process.env): ExtractionSource {
  return env.EXTRACTION_SOURCE?.trim().toLowerCase() === 'harness' ? 'harness' : 'server';
}

/**
 * Harness mode spends no model key anywhere, not only on extraction: a
 * memory that bills the operator's key while an agent with its own model
 * is connected is not the deal (#819). Every server-side chat call — the
 * entity judge, scene enrichment, beliefs, dreams, predicate canonicalization,
 * synthesize — is refused before the network with this error, which every
 * caller already survives as a provider refusal (403: the judge answers
 * "unsure", enrichment is skipped, an answer lane abstains). Measured on a
 * key-less stand: the judge and the scene enricher were the two sites the
 * extraction gate alone left spending.
 */
export class HarnessModeRefusal extends Error {
  readonly status = 403;
  readonly code = 'harness_mode';
  constructor() {
    super('harness mode: the server spends no model key; the connected agent reads and answers');
    this.name = 'HarnessModeRefusal';
  }
}

export function serverModelsRefused(env: NodeJS.ProcessEnv = process.env): boolean {
  return extractionSource(env) === 'harness';
}
