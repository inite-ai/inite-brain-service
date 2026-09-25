import type { Conveyor } from './types';

/**
 * THE RETRIEVAL CONVEYOR — the stages a query actually passes through.
 *
 * `step` is the number the code comment carries in
 * `SearchService.runPipeline`, so the spec test finds each stage in the
 * source and fails when one is added, renumbered or removed without
 * updating this list.
 *
 * DECLARING IT FOUND TWO DELETED LINKS STILL IN THE SPEC.
 * docs/architecture.md drew the pipeline with two stages that do not
 * exist: a PREDICATE + TYPE ROUTER as the first stage (deleted in the S1
 * "delete measurement-killed forks" refactor — the numbering still skips
 * 3, which is the scar) and a HyPE ALT-EMBEDDING LEG as one of three
 * parallel legs (retired by migration 0143). The written specification
 * of how our memory works described two links that are not in the chain.
 */
export const RETRIEVAL_CONVEYOR: Conveyor = {
  id: 'retrieval',
  description: 'A question becomes a ranked set of entities and the facts that answer it.',
  inputs: ['query', 'fact', 'entity', 'edge'],
  outputs: ['results'],
  tracks: 'src/search/search.service.ts',
  stages: [
    {
      step: '1',
      title: 'Retrieval legs (vector + lexical) and convex fusion',
      consumes: ['query', 'fact'],
      produces: ['candidate-rows'],
      gate: 'always',
    },
    {
      step: '1c',
      title: 'Entity-expansion second retrieval — anchored on names the first pass discovered',
      consumes: ['candidate-rows', 'fact'],
      produces: ['candidate-rows'],
      gate: { profile: 'entityExpansion' },
    },
    {
      step: '2',
      title: 'Identity-merge re-attribution and the scope/ABAC row filter',
      consumes: ['candidate-rows', 'entity'],
      produces: ['candidate-rows'],
      gate: 'always',
    },
    {
      step: '2a',
      title: 'Effective-meta union — merged policy metadata onto the surviving rows',
      consumes: ['candidate-rows'],
      produces: ['candidate-rows'],
      gate: { env: 'POLICY_META_UNION_ENABLED' },
    },
    {
      step: '4',
      title: 'Scoring and per-entity bucketing with the diversity-aware degree boost',
      consumes: ['candidate-rows'],
      produces: ['entity-buckets'],
      gate: 'always',
    },
    {
      step: '5',
      title: 'Edge expansion — a graph walk out from the top seeds',
      consumes: ['entity-buckets', 'edge'],
      produces: ['entity-buckets'],
      gate: { profile: 'edgeExpansion' },
    },
    {
      step: '6',
      title: 'PPR cluster lift (HippoRAG-style) over the candidate subgraph',
      consumes: ['entity-buckets', 'edge'],
      produces: ['entity-buckets'],
      gate: { env: 'SEARCH_PPR_ENABLED' },
    },
    {
      step: '6b',
      title: 'Verbatim fusion leg — segments retrieved as first-class hits',
      consumes: ['query', 'entity-buckets'],
      produces: ['entity-buckets'],
      gate: { profile: 'verbatimEvidence' },
    },
    {
      step: '6c',
      title:
        'Relation leg — the edges of the entities the query names, holding at the asked time, retrieved as first-class hits',
      consumes: ['query', 'edge', 'entity-buckets'],
      produces: ['entity-buckets'],
      gate: 'always',
    },
    {
      step: '7',
      title:
        'Cross-encoder and listwise LLM rerank, with one-hop neighbour context; the fact-level cross-encoder rescoring (profile.factRerank) rides beside the LLM call',
      consumes: ['entity-buckets'],
      produces: ['entity-buckets'],
      gate: { profile: 'rerank' },
    },
    {
      step: '8',
      title: 'Fact-centric selection — the result set the caller receives',
      consumes: ['entity-buckets'],
      produces: ['results'],
      gate: { profile: 'factCentric' },
    },
  ],
};
