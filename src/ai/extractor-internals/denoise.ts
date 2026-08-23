import type { ExtractedFact } from './types';

/**
 * Post-extraction denoise pass (flag-gated, default off → identity).
 *
 * The closed-vocabulary LLM extractor over-emits the generic `said`
 * predicate for conversational small-talk despite the prompt reserving it
 * for content-bearing utterances ("never for small talk"). On a LoCoMo
 * conversation ~half of all stored facts are `said` reactions/greetings/
 * questions ("Congrats Caroline!", "What motivates you?", "That cup is so
 * cute.") — pure filler that dilutes BM25/vector retrieval and crowds real
 * attribute facts out of the per-entity synthesis window (worse the wider
 * budget allows). Dropping them at ingest is the single
 * highest-leverage extraction denoise: cleaner retrieval + a synthesis
 * window that holds real facts.
 *
 * EXTRACTOR_DROP_SAID (default off): drop every `said` fact. Deliberately
 * blunt — a small minority of `said` facts do carry content, but the filler
 * dominates and the flag is off by default + eval-gated before enable.
 */
export function denoiseFacts(facts: ExtractedFact[], dropSaid: boolean): ExtractedFact[] {
  if (!dropSaid) return facts;
  return facts.filter((f) => f.predicate !== 'said');
}
