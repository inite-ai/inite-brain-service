/**
 * JobWorkerPool handler for community label propagation.
 *
 * The nightly community rebuild used to run the O(iterations × edges)
 * propagation sweeps on the main thread inside the dreams job. This
 * module lets CommunityBuilderService offload that CPU chunk to the
 * generic worker pool (see job-worker-runner.ts for the envelope):
 * the pool worker dynamic-imports this file and calls `run(input)`.
 *
 * Contract constraints:
 *   - Input and result MUST be structured-clone-able — plain arrays and
 *     objects only, which is why the adjacency Map is built here from
 *     raw edges rather than passed across the postMessage boundary.
 *   - The import chain MUST stay free of Nest/DI so the worker thread
 *     never boots framework code: this file loads ONLY the pure helpers
 *     in ./label-propagation.
 *
 * Determinism: labelPropagation is pure and deterministic, so this
 * off-thread path produces identical clusters to the in-thread fallback
 * in CommunityBuilderService.
 */

export interface LabelPropagationWorkerInput {
  edges: Array<{ from: string; to: string; weight?: number }>;
  /** Sweep cap; omitted → labelPropagation's own default (10). */
  maxIterations?: number;
}

type LabelPropagationModule = typeof import('./label-propagation');

let lpModule: LabelPropagationModule | null = null;

/**
 * Load ./label-propagation in whichever module format this file is
 * running as. After nest build both files are CommonJS .js and the
 * static-looking specifier resolves normally. Under dev / jest the pool
 * worker runs this .ts source directly via Node's native type
 * stripping, which treats it as ESM and does NO extension searching —
 * the relative specifier must name the .ts file explicitly. That
 * fallback specifier is assembled at runtime because tsc (correctly)
 * rejects literal .ts specifiers in emitted code.
 */
async function loadLabelPropagation(): Promise<LabelPropagationModule> {
  if (lpModule) return lpModule;
  try {
    lpModule = (await import('./label-propagation.js')) as LabelPropagationModule;
  } catch {
    const tsSpecifier = './label-propagation' + '.ts';
    lpModule = (await import(tsSpecifier)) as LabelPropagationModule;
  }
  return lpModule;
}

export async function run(input: unknown): Promise<{ clusters: string[][] }> {
  const { edges, maxIterations } = (input ?? {}) as LabelPropagationWorkerInput;
  const { buildAdjacency, labelPropagation } = await loadLabelPropagation();
  const adjacency = buildAdjacency(Array.isArray(edges) ? edges : []);
  const clusters =
    typeof maxIterations === 'number'
      ? labelPropagation(adjacency, maxIterations)
      : labelPropagation(adjacency);
  return { clusters };
}
