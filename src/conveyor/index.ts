import { INGEST_CONVEYOR } from './ingest';
import { RETRIEVAL_CONVEYOR } from './retrieval';
import { SYNTHESIZE_CONVEYOR } from './synthesize';
import type { Artifact, Conveyor, Handoff } from './types';

export type { Artifact, Conveyor, ConveyorId, ConveyorStage, Handoff, StageGate } from './types';
export { INGEST_CONVEYOR } from './ingest';
export { RETRIEVAL_CONVEYOR } from './retrieval';
export { SYNTHESIZE_CONVEYOR } from './synthesize';

/**
 * The whole chain, in the order a fact travels it: a turn becomes rows,
 * rows answer a question, the answer stands on cited rows.
 *
 * Three conveyors and the two joins between them, in one object, because
 * the joins are the part nobody owned. Ingest is "done" when the row is
 * written; retrieval assumes the row is there; synthesize assumes the
 * result carries what it needs to cite. A break at a join does not fail
 * where it happens — it shows up as an empty answer three services away,
 * which is exactly how the belief plane spent months unable to join to
 * the fact plane while both halves reported themselves healthy.
 */
export const CONVEYORS: readonly Conveyor[] = [
  INGEST_CONVEYOR,
  RETRIEVAL_CONVEYOR,
  SYNTHESIZE_CONVEYOR,
];

export const HANDOFFS: readonly Handoff[] = [
  {
    from: 'ingest',
    to: 'retrieval',
    // The graph itself. Retrieval reads no text — the unit of retrieval
    // is a typed fact, and the legs exist only to find one from a query.
    via: ['fact', 'entity', 'edge'],
  },
  {
    from: 'retrieval',
    to: 'synthesize',
    via: ['results'],
  },
  {
    from: 'ingest',
    to: 'synthesize',
    // Three things reach synthesize WITHOUT passing through retrieval:
    // the belief lane queries current-state rows directly, the
    // transcript sections read episodes, and the answer cache
    // revalidates a cached answer against the live fact rows. Declared
    // because an undeclared side-channel is how the belief lane ended up
    // joining nothing — that contract lived in neither plane. The `fact`
    // leg here was found by the assembly gate, not by reading the code.
    via: ['belief', 'episode', 'fact'],
  },
];

/** Every artifact the whole chain ever produces. */
export function producedArtifacts(): ReadonlySet<Artifact> {
  const out = new Set<Artifact>();
  for (const c of CONVEYORS) for (const s of c.stages) for (const a of s.produces) out.add(a);
  return out;
}

/** Every artifact the whole chain ever consumes. */
export function consumedArtifacts(): ReadonlySet<Artifact> {
  const out = new Set<Artifact>();
  for (const c of CONVEYORS) for (const s of c.stages) for (const a of s.consumes) out.add(a);
  return out;
}
