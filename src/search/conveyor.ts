/**
 * THE RETRIEVAL CONVEYOR — the stages a query actually passes through,
 * declared where they run.
 *
 * WHY, after a wrong turn. The first attempt at "declare the conveyor"
 * produced a dictionary of 152 env keys under a new name. That is not a
 * conveyor: it says nothing about what follows what, what each stage
 * consumes, or what it hands on, so it cannot answer the only questions
 * worth asking of an assembly — is a link missing, is a link doing
 * nothing. It was the same bag of flags with a nicer label.
 *
 * The real conveyor was already in the code, as the numbered stages of
 * `SearchService.runPipeline`. This declares those, in order, with what
 * each one takes and produces, and a spec test keeps the declaration and
 * the code from drifting apart.
 *
 * WHAT DECLARING IT FOUND IMMEDIATELY. docs/architecture.md draws the
 * pipeline as a diagram, and two of its stages no longer exist:
 *
 *  - the PREDICATE + TYPE ROUTER, drawn as the first stage with a joint
 *    LLM call and an LRU cache. It was deleted in the S1 "delete
 *    measurement-killed forks" refactor; the numbering in runPipeline
 *    still skips 3, which is the scar it left.
 *  - the HyPE ALT-EMBEDDING LEG, drawn as one of three parallel legs.
 *    Retired by migration 0143 (`retire_alt_embedding_element`); the
 *    only occurrences left in the tree are that migration and the one
 *    that created it.
 *
 * So the written specification of how our memory works described two
 * links that are not in the chain. That is what an assembly nobody
 * declared costs, and it is why the gate below exists.
 */

/** Which conveyor a stage belongs to. Only retrieval is declared so far. */
export type ConveyorId = 'retrieval';

export interface ConveyorStage {
  /** The number the code comment carries, e.g. '1', '1c', '6b'. */
  step: string;
  /** One line: what this stage does to what passes through it. */
  title: string;
  /** What it reads. */
  consumes: string;
  /** What the next stage sees because of it. */
  produces: string;
  /**
   * Always on, gated by a profile field, or gated by an env lane. A
   * stage nothing can switch off is part of the chain by definition.
   */
  gate: 'always' | { profile: string } | { env: string };
}

/**
 * The stages, in execution order, as `SearchService.runPipeline` runs
 * them. `step` is the number in the code comment, so the spec test can
 * find each one and fail when a stage is added, renumbered or removed
 * without updating this list.
 */
export const RETRIEVAL_CONVEYOR: readonly ConveyorStage[] = [
  {
    step: '1',
    title: 'Retrieval legs (vector + lexical) and convex fusion',
    consumes: 'the query text and the tenant row fence',
    produces: 'a fused candidate list of fact rows',
    gate: 'always',
  },
  {
    step: '1c',
    title: 'Entity-expansion second retrieval',
    consumes: 'entity names the first pass discovered but the query never said',
    produces: 'additional fact rows, merged into the same candidate list',
    gate: { profile: 'entityExpansion' },
  },
  {
    step: '2',
    title: 'Identity-merge re-attribution and the scope/ABAC row filter',
    consumes: 'the candidate list plus the tenant policy lookup',
    produces: 'candidates re-pointed at surviving entities, unreadable rows dropped',
    gate: 'always',
  },
  {
    step: '2a',
    title: 'Effective-meta union',
    consumes: 'the filtered candidates',
    produces: 'the same rows carrying merged policy metadata',
    gate: { env: 'POLICY_META_UNION_ENABLED' },
  },
  {
    step: '4',
    title: 'Scoring and per-entity bucketing with the diversity-aware degree boost',
    consumes: 'filtered candidates and the tenant decay policy',
    produces: 'entity buckets carrying a rank score',
    gate: 'always',
  },
  {
    step: '5',
    title: 'Edge expansion — a graph walk out from the top seeds',
    consumes: 'the top entity buckets',
    produces: 'neighbour entities injected as new buckets',
    gate: { profile: 'edgeExpansion' },
  },
  {
    step: '6',
    title: 'PPR cluster lift (HippoRAG-style)',
    consumes: 'the bucket set as a subgraph',
    produces: 'the same buckets with a personalised-PageRank prior folded into rank',
    gate: { env: 'SEARCH_PPR_ENABLED' },
  },
  {
    step: '6b',
    title: 'Verbatim fusion leg — segments retrieved as first-class hits',
    consumes: 'the query, under the fused verbatim profile',
    produces: 'segment buckets scored beside fact buckets',
    gate: { profile: 'verbatimEvidence' },
  },
  {
    step: '7',
    title: 'Cross-encoder and listwise LLM rerank',
    consumes: 'the ranked buckets plus one-hop neighbour context',
    produces: 'the reordered top entities',
    gate: { profile: 'rerank' },
  },
  {
    step: '7b',
    title: 'Fact-level cross-encoder rescoring',
    consumes: 'the facts inside the surviving buckets',
    produces: 'per-fact order within each entity',
    gate: { profile: 'factRerank' },
  },
  {
    step: '8',
    title: 'Fact-centric selection',
    consumes: 'the reranked buckets',
    produces: 'the result set the caller receives',
    gate: { profile: 'factCentric' },
  },
];
