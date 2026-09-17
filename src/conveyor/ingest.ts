import type { Conveyor } from './types';

/**
 * THE INGEST CONVEYOR — a turn of text becomes rows on the graph.
 *
 * Unlike retrieval, this code carries no numbered stage comments, so the
 * order here IS the declaration: it was read off
 * MentionIngestService.ingest and MentionPersistService.persistAll
 * rather than transcribed from a numbering. The spec test therefore
 * checks this conveyor's structure — that every artifact is produced
 * before it is consumed — but cannot check correspondence line by line
 * the way it can for retrieval. Numbering the ingest stages would fix
 * that, and is the obvious next thing.
 */
export const INGEST_CONVEYOR: Conveyor = {
  id: 'ingest',
  description: 'A turn of text becomes resolved entities, facts and edges on the graph.',
  inputs: ['turn-text'],
  outputs: ['episode', 'entity', 'fact', 'edge', 'scene', 'belief'],
  stages: [
    {
      step: 'capture',
      title: 'Episode capture — the raw turn is stored before anything reads it',
      consumes: ['turn-text'],
      produces: ['episode'],
      gate: 'always',
    },
    {
      step: 'extract',
      title: 'LLM extraction — entities, facts and edges read out of the turn',
      consumes: ['turn-text'],
      produces: ['extraction'],
      gate: 'always',
    },
    {
      step: 'embed',
      title: 'Fact embedding — vectors for the facts the extractor produced',
      consumes: ['extraction'],
      produces: ['fact-embedding'],
      gate: 'always',
    },
    {
      step: 'resolve-entities',
      title: 'Entity resolution and upsert — surfaces collapse onto one node',
      consumes: ['extraction'],
      produces: ['entity'],
      gate: 'always',
    },
    {
      step: 'resolve-facts',
      title:
        'Fact resolution — predicate canonicalization, then supersede/compete under the slot policy',
      // The episode id rides in the fact's source, which is what makes a
      // stored fact walkable back to the turn it came from.
      consumes: ['extraction', 'fact-embedding', 'entity', 'episode'],
      produces: ['fact'],
      gate: 'always',
    },
    {
      step: 'persist-edges',
      title: 'Edge persistence — the relations between resolved entities',
      consumes: ['extraction', 'entity'],
      produces: ['edge'],
      gate: 'always',
    },
    {
      step: 'segment',
      title: 'Scene segmentation — episodes composed into windows',
      consumes: ['episode'],
      produces: ['scene'],
      gate: { env: 'SCENES_SEGMENTATION_ENABLED' },
    },
    {
      step: 'promote-beliefs',
      title: 'Belief promotion — scene state-deltas folded into current-state rows',
      consumes: ['scene'],
      produces: ['belief'],
      gate: { env: 'SCENES_BELIEF_PROMOTION' },
    },
  ],
};
