/**
 * Where a claim came from (#909 step 2): said, inferred by a model, a
 * guess put to the person, or a guess they confirmed. GDPR treats an
 * inference about a person as their personal data with its own rights
 * (access, rectification, objection), and an inference that reveals
 * health as special category however tentative (CJEU C-184/20) — so
 * export, contest and erasure have to tell an inference from what the
 * person said. Before this the distinction lived only in predicate names
 * (`stated_affect` vs `hypothesis`) and recorder constants.
 *
 * Two sources, one rule (assertionOf):
 *  - a writer that concludes rather than records (the insight composers,
 *    the compaction summary, the affect reader) stamps
 *    `source.assertion = 'inferred'` with `source.inferredBy`;
 *  - a predicate whose every value is a guess or its confirmation
 *    declares it (`PredicateDefinition.assertion`, e.g. the relationship
 *    pack's `hypothesis`).
 * Anything else — an extracted mention, a direct fact, a document — is
 * what a source stated.
 */
export const ASSERTIONS = ['stated', 'inferred', 'hypothesis', 'confirmed'] as const;
export type Assertion = (typeof ASSERTIONS)[number];

/** What a predicate may declare about every value it holds. */
export const DECLARED_ASSERTIONS = ['hypothesis', 'confirmed'] as const;
export type DeclaredAssertion = (typeof DECLARED_ASSERTIONS)[number];

/** Which writer inferred the claim, and from what. */
export interface InferredBy {
  /** The writer (its recorder constant). */
  recorder: string;
  /** The writer's version (derivedVersion, prompt fingerprint…). */
  version?: string | undefined;
  /** The model that read it, when the writer knows. */
  model?: string | undefined;
  /** The modality it was read from; text unless a processor says otherwise. */
  modality?: string | undefined;
}

/** The `source` stamp of a writer that concludes rather than records. */
export function inferredStamp(by: InferredBy): {
  assertion: 'inferred';
  inferredBy: InferredBy;
} {
  const inferredBy: InferredBy = { recorder: by.recorder, modality: by.modality ?? 'text' };
  if (by.version) inferredBy.version = by.version;
  if (by.model) inferredBy.model = by.model;
  return { assertion: 'inferred', inferredBy };
}

export function isAssertion(v: unknown): v is Assertion {
  return typeof v === 'string' && (ASSERTIONS as readonly string[]).includes(v);
}

/** A claim's assertion: the writer's stamp, else its predicate's declaration, else stated. */
export function assertionOf(source: unknown, declared?: string | undefined): Assertion {
  const stamped = (source as { assertion?: unknown } | null | undefined)?.assertion;
  if (isAssertion(stamped)) return stamped;
  if (isAssertion(declared)) return declared;
  return 'stated';
}
