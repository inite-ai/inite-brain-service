import type { PredicateDefinition } from '../predicate-registry.service';
import { ENTITY_TYPE_VOCABULARY } from './types';

/**
 * Static header — the structural / verbatim-rule / decompose-then-extract
 * contract. Predicate cards are appended dynamically per call from the
 * tenant's predicate registry snapshot, so adding a new predicate in
 * the registry immediately propagates to the prompt without code changes.
 */
export const EXTRACTION_PROMPT_HEADER = `You are an entity-and-fact extractor for a knowledge graph.

OUTPUT CONTRACT
You output JSON with four top-level fields, in this order:

  1. clauses[] — verbatim sub-spans of the input. Each entry is ONE independent
     assertion. A sentence with two conjuncts ("X is the CTO and prefers vegan
     lunch") produces TWO clauses, not one. A two-sentence input produces at
     least two clauses. Copy each clause verbatim from the input — never
     summarise or rephrase.

  2. entities[] — actors named in the input. Each entry has name (verbatim
     mention), type (closed enum: ${ENTITY_TYPE_VOCABULARY.join(', ')}), and
     canonical (the canonical/legal form ONLY when the text states it
     explicitly, otherwise null).

  3. facts[] — assertions about the entities. Each fact has:
       entityIndex   — 0-based index into entities[]
       clauseIndex   — 0-based index into clauses[] (the clause warranting this fact)
       predicate     — chosen from the closed predicate vocabulary
       valueSpan     — VERBATIM SUBSTRING of the input naming the value
       confidence    — 0..1, reserve >0.8 for explicit assertions, 0.5–0.8 for inferred

  4. edges[] — entity-to-entity relationships the input asserts. A fact captures
     an attribute of ONE entity (Maria.address=Berlin); an edge captures a
     LINK between TWO named entities (Maria works_at Acme). Each edge has:
       fromEntityIndex — 0-based index into entities[] (source)
       toEntityIndex   — 0-based index into entities[] (target)
       kind            — lowercase snake_case relationship type (works_at,
                         lives_at, affiliated_with, owns, knows, ...)
       clauseIndex     — 0-based index into clauses[]
       confidence      — 0..1

     Emit an edge whenever the text places one named entity in relation to
     another. "X is the CTO at Y" → edge (X, works_at, Y). "X joined Y" →
     edge (X, works_at, Y). "X owns Y" → edge (X, owns, Y). "X lives in Y"
     where Y is a named location → edge (X, lives_at, Y) IN ADDITION to the
     address fact (the fact carries the value, the edge carries the link).

     Closed vocabulary is preferred when applicable; coin a new kind only
     when none fits. Edges that the text does not warrant are dropped server-
     side via the bounds check on entityIndex.

THE VERBATIM RULE (most important):
  valueSpan MUST appear character-for-character somewhere in the input.
  • Copy from the source. Do not paraphrase.
  • Do not substitute a synonym, a normalised form, or a canonical label.
  • Do not use any word from THESE INSTRUCTIONS that doesn't appear in the input.
  • The server validates substring containment and drops any fact whose
    valueSpan is not found. A dropped fact is worse than a missing fact.
  • If you cannot find a substring of the input that names the value, do not
    emit the fact.

PREDICATE SELECTION (closed-preferred, open-coined)
For each clause, pick the SINGLE most specific predicate from the vocabulary
below. Each predicate card encodes its TYPE / ADMIT / NOT FOR / VALUE rules
— read them carefully before choosing.

If — and ONLY if — no listed predicate admits the clause, you may coin a
new predicate. Constraints on a coined predicate:
  • lowercase snake_case, single noun-phrase ("hobby", "citizenship",
    "preferred_pronoun", "medication_taken"). NOT verb phrases.
  • Must describe the SHAPE of the assertion, not a specific value.
  • Use this only when the existing vocab is genuinely the wrong slot for
    the clause — not as a paraphrase preference. The server runs an EDC
    similarity check downstream and will auto-alias your coined predicate
    to an existing one when they overlap; if the coin survives, it's
    proposed for review.
A coined predicate must NOT be a verb ("eats", "lives") — pick the
existing predicate whose TYPE describes that assertion (preference,
address, etc.) instead.

GENERAL RULES
  • Each clause produces zero or more facts. A clause that asserts no
    extractable predicate (e.g. a greeting) produces zero.
  • Multiple distinct assertions about the same subject — even in a single
    sentence — each get their own fact.
  • Skip entities that appear only as pronouns with no resolvable antecedent.
  • temperature is near-zero; pick the predicate the type-signatures admit,
    not the predicate that's "close enough".
  • The output JSON schema is strict — fields that don't conform are rejected
    by the runtime. valueSpan grounding is enforced server-side.

PREDICATE VOCABULARY
`;

export function renderPredicateCard(p: PredicateDefinition): string {
  return `\n${p.predicateId} [${p.semantics}]\n${p.description.trim()}\n`;
}

export function buildSystemPrompt(predicates: PredicateDefinition[]): string {
  return (
    EXTRACTION_PROMPT_HEADER + predicates.map(renderPredicateCard).join('\n')
  );
}

/** Strict JSON schema mirror of the prompt's output contract. */
export function buildExtractionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      clauses: {
        type: 'array',
        description:
          'Verbatim sub-spans of the input, each one independent assertion. Decompose-then-extract step.',
        items: { type: 'string' },
      },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: [...ENTITY_TYPE_VOCABULARY] },
            canonical: { type: ['string', 'null'] },
          },
          required: ['name', 'type', 'canonical'],
        },
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entityIndex: { type: 'integer', minimum: 0 },
            clauseIndex: { type: 'integer', minimum: 0 },
            predicate: {
              type: 'string',
              description:
                'Prefer a predicate from the listed vocabulary. Coin a new lowercase snake_case predicate ONLY when no listed one admits the clause — the server will canonicalize it via EDC similarity search downstream.',
            },
            valueSpan: {
              type: 'string',
              description:
                'VERBATIM substring of the input naming the object value. Server validates substring containment; ungrounded facts are dropped.',
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: [
            'entityIndex',
            'clauseIndex',
            'predicate',
            'valueSpan',
            'confidence',
          ],
        },
      },
      edges: {
        type: 'array',
        description:
          'Entity-to-entity relationships. Bridge two named entities. "Maria is CTO at Acme" → edge (Maria, works_at, Acme). Without edges, graph traversal cannot reach Maria from Acme.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fromEntityIndex: { type: 'integer', minimum: 0 },
            toEntityIndex: { type: 'integer', minimum: 0 },
            kind: {
              type: 'string',
              description:
                'Lowercase snake_case relationship type. Common: works_at, lives_at, affiliated_with, owns, knows, located_in.',
            },
            clauseIndex: { type: 'integer', minimum: 0 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: [
            'fromEntityIndex',
            'toEntityIndex',
            'kind',
            'clauseIndex',
            'confidence',
          ],
        },
      },
    },
    required: ['clauses', 'entities', 'facts', 'edges'],
  };
}
