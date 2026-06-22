import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/predicates.
 *
 * **Duplicate** of src/contracts/admin/predicates.schema.ts.
 */

const SemanticsSchema = z.enum([
  'append_only',
  'single_active',
  'bitemporal',
])

const PiiClassSchema = z.enum([
  'none',
  'identifier',
  'behavioral',
  'text',
  'sensitive',
])

const PredicateStatusSchema = z.enum([
  'active',
  'proposed',
  'aliased',
  'deprecated',
])

const PredicateDatatypeSchema = z.enum([
  'string',
  'number',
  'date',
  'datetime',
  'enum',
  'json',
])

const PredicateCreatedBySchema = z.enum([
  'system',
  'admin',
  'llm_auto',
  'migration',
])

const PredicateDefinitionSchema = z.object({
  predicateId: z.string(),
  displayLabel: z.string(),
  description: z.string(),
  datatype: PredicateDatatypeSchema,
  semantics: SemanticsSchema,
  decayHalfLifeDays: z.number().nullable(),
  piiClass: PiiClassSchema,
  requiresScope: z.string().optional(),
  parentPredicateId: z.string().optional(),
  subjectClasses: z.array(z.string()).optional(),
  allowedValues: z.array(z.string()).optional(),
  status: PredicateStatusSchema,
  aliasedTo: z.string().optional(),
  createdBy: PredicateCreatedBySchema,
})

export const PredicatesListResponseSchema = z.object({
  predicates: z.array(PredicateDefinitionSchema),
})

export type PredicatesListResponse = z.infer<
  typeof PredicatesListResponseSchema
>
export type Predicate = z.infer<typeof PredicateDefinitionSchema>
export type Semantics = z.infer<typeof SemanticsSchema>
export type PiiClass = z.infer<typeof PiiClassSchema>
export type PredicateStatus = z.infer<typeof PredicateStatusSchema>
