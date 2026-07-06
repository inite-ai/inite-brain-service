import type { CodeMemoryKind } from '../../ai/domain-packs';

/**
 * Frozen golden fixture for the code-memory eval. Small, hand-authored records
 * (real decisions from this repo's history) + queries with expected recall. The
 * eval ingests these into an ephemeral tenant and scores retrieval + invariant
 * surfacing. Grow this set as the domain matures — it's the code-memory analog
 * of test/eval/golden-baseline.json.
 */

export interface GoldenRecord {
  anchor: string;
  kind: CodeMemoryKind;
  text: string;
}

export interface GoldenQuery {
  id: string;
  /** The code anchor an agent is touching (exact `why` lookup). */
  anchor: string;
  /** A natural-language query for the semantic-recall dimension. */
  semanticQuery: string;
  /** Kinds that MUST come back from `why(anchor)`. */
  expectKinds: CodeMemoryKind[];
}

export const GOLDEN_RECORDS: GoldenRecord[] = [
  {
    anchor: 'src/ingest/fact-resolver.service.ts#FactResolverService.resolve',
    kind: 'decided',
    text: 'Route every fact write through one fn::resolve_fact gateway so the 21-positional-arg call lives in exactly one place.',
  },
  {
    anchor: 'src/ingest/fact-resolver.service.ts#FactResolverService.resolve',
    kind: 'because',
    text: 'The two call-sites had drifted the positional arguments out of sync, binding values to the wrong slots.',
  },
  {
    anchor: 'src/ingest/fact-resolver.service.ts#FactResolverService.resolve',
    kind: 'invariant',
    text: 'Conflict weights must be read from process.env, never added as a fourth ConfigService constructor dependency.',
  },
  {
    anchor: 'src/ai/domain-packs/manifest.ts#composePredicateId',
    kind: 'decided',
    text: 'Namespace every pack predicate as packId__localId.',
  },
  {
    anchor: 'src/ai/domain-packs/manifest.ts#composePredicateId',
    kind: 'invariant',
    text: 'Never use a slash as the namespace separator — it breaks admin route parameters and the predicate-id charset.',
  },
  {
    anchor: 'src/jobs/worker-loop.service.ts#WorkerLoopService',
    kind: 'gotcha',
    text: 'Always export a new @Injectable from the @Global module or the full e2e DI-boot goes red.',
  },
];

export const GOLDEN_QUERIES: GoldenQuery[] = [
  {
    id: 'resolver-gateway',
    anchor: 'src/ingest/fact-resolver.service.ts#FactResolverService.resolve',
    semanticQuery: 'why is there a single gateway for resolving facts',
    expectKinds: ['decided', 'because', 'invariant'],
  },
  {
    id: 'pack-namespacing',
    anchor: 'src/ai/domain-packs/manifest.ts#composePredicateId',
    semanticQuery: 'how are domain pack predicate names namespaced',
    expectKinds: ['decided', 'invariant'],
  },
  {
    id: 'global-injectable',
    anchor: 'src/jobs/worker-loop.service.ts#WorkerLoopService',
    semanticQuery: 'gotcha about exporting an injectable from the global module',
    expectKinds: ['gotcha'],
  },
];
