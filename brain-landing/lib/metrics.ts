/**
 * Brain quality metrics — single source of truth for the Stats block.
 *
 * Numbers come from the latest gate run of `inite-brain-service/test/eval/`
 * against the multi-vertical scenario suite (n=255) plus 180 wikidata
 * queries (90 Latin + 90 Cyrillic). Bootstrap-CI on the retrieval legs.
 * The `floor` is the CI gate threshold — a run under it fails the build.
 */

export interface Metric {
  /** Display label. */
  label: string
  /** Latest baseline value (string for layout stability — display only). */
  value: string
  /** Bootstrap 95% CI, where measured (retrieval legs). */
  ci?: string
  /** CI gate threshold. */
  floor: string
  /** One-sentence tooltip. */
  hint: string
}

export const METRICS: Metric[] = [
  {
    label: 'recall@1',
    value: '0.965',
    ci: '0.94–0.98',
    floor: '≥ 0.6',
    hint: 'Top-1 retrieval correctness across the multi-vertical scenario suite (n=255).',
  },
  {
    label: 'MRR',
    value: '0.979',
    ci: '0.97–0.99',
    floor: '≥ 0.5',
    hint: 'Mean reciprocal rank of the first relevant fact (n=255).',
  },
  {
    label: 'NDCG@10',
    value: '0.979',
    floor: '≥ 0.7',
    hint: 'Ranking quality across the top-10 window (n=255).',
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
