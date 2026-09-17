import type { Conveyor } from './types';

/**
 * THE SYNTHESIZE CONVEYOR — retrieved rows become a grounded answer.
 *
 * Read off SynthesizeService.synthesizeGrounded. Like ingest, this code
 * carries no numbered stage comments, so the order here is the
 * declaration and the spec test checks structure rather than
 * correspondence.
 *
 * The belief lane is the stage this wave rebuilt: it renders the current
 * state beside the facts, and the damping pass demotes fact lines a
 * current belief contradicts. Both are declared here because the
 * cross-plane join they need — one slot identity for beliefs and facts
 * — was the thing that did not exist, and a conveyor that does not name
 * the stage cannot show that its input was missing.
 */
export const SYNTHESIZE_CONVEYOR: Conveyor = {
  id: 'synthesize',
  description: 'Retrieved rows become an answer that may only stand on cited evidence.',
  // `fact` is here because the answer cache reads the fact table
  // DIRECTLY — a cached answer is only served after its facts are
  // revalidated against the live rows. That is a third channel from
  // ingest into synthesize, beside results and the belief/episode
  // side-channel, and the assembly gate is what surfaced it: the stage
  // read an artifact this conveyor never declared it received.
  inputs: ['query', 'results', 'belief', 'episode', 'fact'],
  outputs: ['answer', 'citations'],
  stages: [
    {
      step: 'cache',
      title: 'Answer cache — an exact-key serve, revalidated against the facts behind it',
      consumes: ['query', 'fact'],
      produces: ['answer', 'citations'],
      gate: { env: 'SYNTHESIZE_ANSWER_CACHE' },
    },
    {
      step: 'dispatch',
      title: 'Lane dispatch — the question class that shapes retrieval and the prompt',
      consumes: ['query'],
      produces: ['query'],
      gate: 'always',
    },
    {
      step: 'guardrail',
      title: 'Conformal guardrail — facts below the calibrated confidence floor are dropped',
      consumes: ['results'],
      produces: ['results'],
      gate: 'always',
    },
    {
      step: 'abstain',
      title: 'Coverage abstention — refuse rather than answer off insufficient evidence',
      consumes: ['results'],
      produces: ['answer'],
      gate: 'always',
    },
    {
      step: 'belief-lane',
      title: 'Belief lane — the current-state section rendered beside the facts',
      consumes: ['belief'],
      produces: ['prompt-sections'],
      gate: { env: 'BELIEFS_SERVING_LANE' },
    },
    {
      step: 'sections',
      title: 'Prompt assembly — fact lines, transcript quotes, insights, evidence',
      consumes: ['results', 'episode'],
      produces: ['prompt-sections'],
      gate: 'always',
    },
    {
      step: 'damping',
      title: 'Belief-aware fact damping — demote fact lines a current belief contradicts',
      consumes: ['prompt-sections', 'belief'],
      produces: ['prompt-sections'],
      gate: { env: 'BELIEFS_FACT_DAMPING' },
    },
    {
      step: 'generate',
      title: 'Generation — the answer, under a strict schema that must cite',
      consumes: ['prompt-sections'],
      produces: ['answer', 'citations'],
      gate: 'always',
    },
    {
      step: 'verify',
      title: 'Verification — the answer re-checked against the same damped lines',
      consumes: ['answer', 'prompt-sections'],
      produces: ['answer'],
      gate: 'always',
    },
  ],
};
