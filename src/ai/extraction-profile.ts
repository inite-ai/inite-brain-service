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
  /**
   * DERIVER_COMPLETION_PASS (V7 deriver-recall): after the base
   * proposition pass, run a second "what was missed" call that sees the
   * base list and returns ONLY additional propositions; union with
   * text-level dedup. Off → the deriver is byte-identical single-pass
   * (ewave rule: worlds derived under different prompts/pass counts
   * must not share a version — confirm on a FRESH derivedVersion).
   */
  deriveCompletionPass: boolean;
  /**
   * DERIVER_SALIENCE_STAMP (V8 §4, importance-scoring design note):
   * the deriver also judges a 0-3 salience per proposition (0
   * incidental, 1 routine, 2 notable, 3 identity-central) and the
   * write stamps it as source.salience. Read-side use is separately
   * gated (RETRIEVAL_SALIENCE_SCORING); rows without the stamp read as
   * neutral. Off → prompt and schema byte-identical (ewave rule: a
   * prompt change confirms on a FRESH derivedVersion).
   */
  deriveSalienceStamp: boolean;
  /**
   * DERIVER_MENTION_STAMP (V12 §1, the graphiti reference_time port):
   * each derived fact is stamped with the event time of ITS first
   * grounding turn — source.mentionedAt (per-turn occurredAt, not the
   * session date) + source.turnIndex (within-session ordinal). Pure
   * metadata: no prompt change, no schema migration, no resolver
   * change (source is FLEXIBLE). This is what makes mention ORDER
   * recoverable from facts — extraction currently collapses a
   * session's mentions onto one validFrom (the measured event_ordering
   * failure). Read-side consumers ship with the V12 ordering leg;
   * unstamped rows read as before. Off → byte-identical writes.
   */
  deriveMentionStamp: boolean;
  /**
   * DERIVER_TURN_HEADERS (V13 structural, the graphiti reference_time
   * prompt shape): the transcript renders per-turn timestamp headers —
   * `[N] (YYYY-MM-DD HH:MM) speaker: text` — instead of the bare
   * `[N] speaker: text` under one session-date line, plus a system
   * section telling the deriver to resolve occurred_on against the
   * TURN's own timestamp. Session-date fallback for undated events is
   * kept verbatim (the armK lesson: stripping it measured −4.9). The
   * LLM-returned turns[] already carries episode indices, so mention
   * stamping is unchanged. Prompt change ⇒ fresh derivedVersion; off →
   * byte-identical prompt.
   */
  deriveTurnHeaders: boolean;
  /**
   * DERIVER_DATE_RESOLVE (V12 §3, the graphiti anti-collapse port for
   * event dating): a prompt section hardening `occurred_on` — resolve
   * relative time by calendar arithmetic from the session date, date
   * the EVENT never the conversation, session date only for same-day
   * events, null over a fabricated default. Targets the measured
   * off-by-days class (validFrom = session-date collapse). Prompt
   * change ⇒ confirms only on a FRESH derivedVersion; off →
   * byte-identical prompt.
   */
  deriveDateResolve: boolean;
  /**
   * DERIVER_DATE_AUDIT (V13): a dedicated after-emission turn
   * re-deriving occurred_on for every proposition against the
   * transcript + session date. The post-pass shape of the failed
   * in-prompt rules (armH null; the salience-v2 lesson: grading after
   * emission works where prompt sections do not). One extra call per
   * session; failure degrades to un-audited dates.
   */
  deriveDateAudit: boolean;
  /**
   * DERIVER_ASPECT_ROLLUPS (V13, July A2): mechanical per-(entity,
   * aspect) list-facts composed from the conversation's landed rows —
   * write-time composition for the MH-enumeration miss class (every
   * item exists atomically, no atom holds the list). LLM-free and
   * deterministic; rollups write as `<aspect>_rollup` so they never
   * compete in member slots. Fresh derivedVersion required.
   */
  deriveAspectRollups: boolean;
  /**
   * DERIVER_COMPOSE_PASS (V13, the PREMem write-time composition
   * shape): after a conversation's sessions derive, ONE extra LLM call
   * over its landed atoms emits multi-atom compositions —
   * accumulations, transformations-with-dates, specifications and
   * explicitly-supported connections — as ordinary derived rows
   * (source.composed=true, provenance = union of member grounding).
   * The measured multi-hop miss class is exactly "every atom exists,
   * no atom states the combination"; the mechanical rollup (armL)
   * measured negative, this is the LLM-composed alternative with
   * on-genre published ablations. Fresh derivedVersion required.
   */
  deriveComposePass: boolean;
  /**
   * DERIVER_SCENE_TRACE (V13, the dual-trace encoding port — arXiv
   * 2604.12948, +20.2pp LongMemEval-S in their controlled pair): each
   * proposition also carries a one-clause `scene` — the concrete
   * situation it was learned in — stamped as source.scene and folded
   * into the row's embedding text, so situational questions find facts
   * the bare proposition text never matches. Read-side rendering is
   * separately gated (RETRIEVAL_SCENE_TRACES). Schema + prompt change
   * ⇒ fresh derivedVersion; off = byte-identical call.
   */
  deriveSceneTrace: boolean;
  /**
   * DERIVER_DIGEST (V12 §2, the graphiti saga port; LIGHT ablation:
   * the scratchpad is the load-bearing 100K component, +160% on
   * summarization): the deriver ALSO folds each session
   * chronologically into one bounded rolling digest per conversation
   * (conversation_digest, 0086) — the narrative arc with day stamps
   * that summarization golds ask for and fact extraction keeps
   * thinnest. One extra LLM call per session. Read-side use is
   * separately gated (RETRIEVAL_DIGEST_EVIDENCE, ships with the V12
   * leg); off → no calls, no writes, byte-identical derive.
   */
  deriveDigest: boolean;
  /**
   * DERIVER_SLOT_SEMANTICS (V9 §1, derived-world lifecycle): value-
   * bearing aspects (VALUE_BEARING_ASPECTS in fact-resolver) resolve
   * as 'bitemporal_event' — similarity+interval-gated competing pool,
   * event-time recency, later-validFrom-wins supersede (migration
   * 0083) — so derived worlds get knowledge-update supersede and
   * genuine same-date COMPETING rows for the contradiction lane.
   * Event-like aspects stay append_only. Off → byte-identical writes
   * (ewave rule: lifecycle-on worlds take a FRESH derivedVersion).
   */
  deriveSlotSemantics: boolean;
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
    deriveCompletionPass: envFlagEnabled(env.DERIVER_COMPLETION_PASS),
    deriveSalienceStamp: envFlagEnabled(env.DERIVER_SALIENCE_STAMP),
    deriveMentionStamp: envFlagEnabled(env.DERIVER_MENTION_STAMP),
    deriveTurnHeaders: envFlagEnabled(env.DERIVER_TURN_HEADERS),
    deriveDateResolve: envFlagEnabled(env.DERIVER_DATE_RESOLVE),
    deriveDateAudit: envFlagEnabled(env.DERIVER_DATE_AUDIT),
    deriveAspectRollups: envFlagEnabled(env.DERIVER_ASPECT_ROLLUPS),
    deriveComposePass: envFlagEnabled(env.DERIVER_COMPOSE_PASS),
    deriveSceneTrace: envFlagEnabled(env.DERIVER_SCENE_TRACE),
    deriveDigest: envFlagEnabled(env.DERIVER_DIGEST),
    deriveSlotSemantics: envFlagEnabled(env.DERIVER_SLOT_SEMANTICS),
  };
}
