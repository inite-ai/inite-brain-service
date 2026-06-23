/**
 * Internal progress-event shape used by MultiHopService + SynthesizeService
 * to surface long-running stage transitions. The MCP tool handlers
 * translate ProgressEvent into `notifications/progress` when the
 * caller supplied a progressToken; HTTP callers ignore them.
 *
 * Coarse-grained on purpose — one tick per logical stage, not per
 * sub-call. Fine-grained streaming (e.g. token-by-token synthesizer
 * output) is a v2 lift that needs StreamableHTTP eventStore support
 * which brain runs without today.
 */
export interface ProgressEvent {
  /** Short stage identifier — 'planning' | 'hop' | 'generate' | 'verify' | 'done' | … */
  stage: string;
  /** 1-based when applicable (e.g. hop number). */
  index?: number;
  /** Total expected — used for `progress / total` UIs. */
  total?: number;
  /** Optional human-readable text the client can display. */
  message?: string;
}

export type ProgressReporter = (event: ProgressEvent) => void;

/** No-op default — services call it unconditionally so the caller side decides. */
export const NOOP_REPORTER: ProgressReporter = () => undefined;
