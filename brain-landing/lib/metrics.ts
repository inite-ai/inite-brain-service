/**
 * Brain quality metrics — single source of truth for the Stats block,
 * the Hero proof-points, and the README mirror in /docs/getting-started.
 *
 * These are CI hard-floors. The Numbers come from
 * `inite-brain-service/test/eval/` baseline runs against the multi-
 * vertical scenario suite plus the wikidata directory.
 */

export interface Metric {
  /** Display label. */
  label: string
  /** Latest baseline value (string for layout stability — display only). */
  value: string
  /** CI gate threshold. */
  floor: string
  /** One-sentence tooltip. */
  hint: string
}

export const METRICS: Metric[] = [
  {
    label: 'recall@1',
    value: '0.965',
    floor: '≥ 0.6',
    hint: 'Top-1 retrieval correctness across the multi-vertical scenario suite (n=255).',
  },
  {
    label: 'faithfulness',
    value: '1.000',
    floor: '≥ 0.8',
    hint: 'RAGAS-style claim verifier pass-rate on /v1/synthesize answers.',
  },
  {
    label: 'identity-F1',
    value: '1.000',
    floor: '≥ 0.8',
    hint: 'B³-style identity-resolution F1 with declared distractors.',
  },
  {
    label: 'memory-lifecycle',
    value: '1.000',
    floor: '= 1.0',
    hint: 'Update / supersede / retract / forget assertions — must equal 1.0.',
  },
]
