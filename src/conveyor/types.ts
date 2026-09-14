/**
 * THE CONVEYOR — what the memory does to something, in order, end to end.
 *
 * WHY A CONTROLLED VOCABULARY. The first version of this described each
 * stage's input and output as free text, which reads fine and checks
 * nothing: "the filtered candidates" and "candidates re-pointed at
 * surviving entities" are the same thing written twice, and no test can
 * tell. So the things that flow are a closed set of ARTIFACTS, and a
 * stage names the ones it reads and the ones it leaves behind.
 *
 * That is what makes the two questions mechanical, which is the whole
 * point of declaring an assembly:
 *
 *   - a stage that PRODUCES an artifact no later stage consumes and that
 *     is not a terminal output is a superfluous link;
 *   - a stage that CONSUMES an artifact no earlier stage produces and
 *     that is not an external input is a missing link.
 *
 * Both are failing tests in conveyor.unit-spec.ts rather than something
 * somebody notices a year later.
 */

/** Everything that flows between stages. Closed on purpose. */
export type Artifact =
  // ── ingest side ───────────────────────────────────────────────────
  | 'turn-text' // what the caller sent
  | 'episode' // the captured raw turn (L0)
  | 'extraction' // entities + facts + edges the extractor read out
  | 'fact-embedding' // per-fact vectors
  | 'entity' // a resolved entity row
  | 'fact' // a stored, conflict-resolved fact row
  | 'edge' // a stored relation between entities
  | 'scene' // a segmented episode window
  | 'belief' // a promoted current-state row
  // ── retrieval side ────────────────────────────────────────────────
  | 'query' // the caller's question
  | 'candidate-rows' // fused fact rows, before scoring
  | 'entity-buckets' // candidates grouped per entity with a rank score
  | 'results' // the ranked entities + facts a caller receives
  // ── synthesize side ───────────────────────────────────────────────
  | 'prompt-sections' // fact lines, belief lane, transcript, insights
  | 'answer' // generated text
  | 'citations'; // the evidence the answer is allowed to stand on

/** How a stage can be switched off. `always` means it is the chain. */
export type StageGate = 'always' | { profile: string } | { env: string };

export interface ConveyorStage {
  /**
   * Stable id. For conveyors whose code carries numbered stage comments
   * this is that number ('1', '1c', '6b'), so the spec test can find the
   * stage in the source and fail when one is added, renumbered or
   * removed without updating the declaration.
   */
  step: string;
  /** One line: what this stage does to what passes through it. */
  title: string;
  consumes: readonly Artifact[];
  produces: readonly Artifact[];
  gate: StageGate;
}

export interface Conveyor {
  id: ConveyorId;
  /** What this conveyor is for, in one line. */
  description: string;
  /** Artifacts that arrive from outside — a caller, or another conveyor. */
  inputs: readonly Artifact[];
  /** Artifacts this conveyor exists to leave behind. */
  outputs: readonly Artifact[];
  stages: readonly ConveyorStage[];
  /**
   * The file whose numbered stage comments this declaration tracks, or
   * undefined when the conveyor's code carries no numbering yet — in
   * which case the order here is the declaration and the spec test can
   * only check its structure, not its correspondence.
   */
  tracks?: string;
}

export type ConveyorId = 'ingest' | 'retrieval' | 'synthesize';

/**
 * How one conveyor feeds the next. Declared rather than inferred,
 * because the join is the part nobody owns: ingest is done when the row
 * is written and retrieval assumes the row is there, so a break here
 * shows up as an empty answer three services away.
 */
export interface Handoff {
  from: ConveyorId;
  to: ConveyorId;
  /** What crosses. Must be an output of `from` and an input of `to`. */
  via: readonly Artifact[];
}
