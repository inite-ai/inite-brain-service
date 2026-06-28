import { composePredicateId, type DomainPackManifest } from './manifest';

/**
 * The first real Domain Pack: code-memory (docs/roadmap/code-memory-domain.md).
 * The non-derivable engineering "why" of a codebase — decisions, rationale,
 * invariants, gotchas — anchored to code anchors. Previously these predicates
 * were hardcoded in CORE_PREDICATES (Phase 0 PoC shortcut); they now live here
 * as a versioned, namespaced pack, proving the pack standard end-to-end.
 *
 * Bump `version` to ship an updated code-memory ontology.
 */
export const CODE_MEMORY_PACK: DomainPackManifest = {
  id: 'code_memory',
  version: '0.1.0',
  description:
    'Non-derivable engineering "why" of a codebase — decisions, rationale, invariants, gotchas anchored to code.',
  predicates: [
    {
      localId: 'decided',
      displayLabel: 'decided',
      description: `TYPE   subject is a code anchor; value is a design decision
ADMIT  text states a design/implementation decision made for this code
       location ("resolve facts through one gateway", "split per phase")
VALUE  the decision statement`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'because',
      displayLabel: 'because',
      description: `TYPE   subject is a code anchor; value is the rationale for a decision
ADMIT  text gives the reason a decision was made ("21 positional args
       drifted between call-sites")
VALUE  one rationale per fact (multi-valued)`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'invariant',
      displayLabel: 'invariant',
      description: `TYPE   subject is a code anchor; value is a constraint that must hold
ADMIT  text states a rule the code must satisfy ("always export a new
       @Injectable from the @Global module or e2e DI-boot fails")
VALUE  the invariant statement`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'gotcha',
      displayLabel: 'gotcha',
      description: `TYPE   subject is a code anchor; value is a non-obvious trap
ADMIT  text warns of a counter-intuitive behaviour or pitfall
       ("pnpm test -- --testPathPattern does NOT work — double dash")
VALUE  one gotcha per fact (multi-valued)`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
};

/** The pack-local kinds, in author order. The ergonomic surface for the MCP
 *  `record_decision` tool + the capture pipeline (callers pass `decided`, not
 *  the namespaced id). */
export const CODE_MEMORY_KINDS = ['decided', 'because', 'invariant', 'gotcha'] as const;
export type CodeMemoryKind = (typeof CODE_MEMORY_KINDS)[number];

/** Fully-qualified, namespaced predicate id for a code-memory kind, e.g.
 *  `code_memory__decided`. Single source of truth for every consumer. */
export function codeMemoryPredicateId(kind: CodeMemoryKind): string {
  return composePredicateId(CODE_MEMORY_PACK.id, kind);
}

/** The set of namespaced code-memory predicate ids (for filtering reads). */
export const CODE_MEMORY_PREDICATE_IDS: string[] = CODE_MEMORY_KINDS.map(
  codeMemoryPredicateId,
);

/** Strip the pack prefix from a namespaced id → the local kind (for display). */
export function codeMemoryKindOf(predicateId: string): string {
  const prefix = `${CODE_MEMORY_PACK.id}__`;
  return predicateId.startsWith(prefix)
    ? predicateId.slice(prefix.length)
    : predicateId;
}
