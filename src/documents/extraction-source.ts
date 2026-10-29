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
