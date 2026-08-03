import { envFlagEnabled } from '../common/env-validation';

/**
 * ExtractionPipelineProfile — the configuration object of the ONE
 * extraction pipeline (platform directive 2026-08-03, S4). The three
 * historical tracts (closed-vocab span-grounded / open dialogue /
 * aspect-slug deriver) differ in VOCABULARY and VALUE SHAPE — that is
 * per-tenant configuration, not three code paths. This resolver is the
 * only place the extraction env keys are read (S5.2 gate); everything
 * in src/ai/extractor-* and the window deriver takes the resolved
 * profile.
 */
export interface ExtractionPipelineProfile {
  /**
   * 'closed' — the CRM predicate vocabulary, verbatim span-grounded
   * values. 'open' — the dialogue tract: coined predicates kept,
   * normalized values, actor attribution, grounding-drop bypassed.
   */
  vocabulary: 'closed' | 'open';
  /**
   * Admit the LLM's proposed minimal clean value when every word
   * appears in the grounded span. Only meaningful on the closed
   * vocabulary — the open profile normalizes through its own contract,
   * so consumers apply `vocabulary === 'closed' && normalizeObjects`.
   */
  normalizeObjects: boolean;
  /** Specialist extraction pass per detected facet (open vocab only). */
  facetRouting: boolean;
  /** Drop bare `said` residuals at ingest instead of storing chatter. */
  dropSaid: boolean;
  /** Let the local pre-pass skip the extractor LLM call when it hits. */
  skipLlmPrePass: boolean;
  /** Refinement collapse threshold for the local predicate selector. */
  refinePredicateThreshold: number;
  /** Deriver also emits assistant-side contributions ("assistance"). */
  deriveAssistantContent: boolean;
}

/** Boot-default profile from env — the single reader of these keys. */
export function resolveExtractionProfile(
  env: NodeJS.ProcessEnv = process.env,
): ExtractionPipelineProfile {
  const open = envFlagEnabled(env.EXTRACTOR_DIALOGUE_PROFILE);
  const threshold = parseFloat(
    env.EXTRACTOR_LOCAL_PREDICATE_THRESHOLD ?? '0.45',
  );
  return {
    vocabulary: open ? 'open' : 'closed',
    normalizeObjects: envFlagEnabled(env.EXTRACTION_OBJECT_NORMALIZE),
    facetRouting: open && envFlagEnabled(env.EXTRACTOR_ROUTING_ENABLED),
    dropSaid: envFlagEnabled(env.EXTRACTOR_DROP_SAID),
    skipLlmPrePass: envFlagEnabled(env.EXTRACTOR_SKIP_LLM_ENABLED),
    refinePredicateThreshold: Number.isFinite(threshold) ? threshold : 0.45,
    deriveAssistantContent: envFlagEnabled(env.DERIVER_ASSISTANT_CONTENT),
  };
}
