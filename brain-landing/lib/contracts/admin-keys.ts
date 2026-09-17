import { z } from 'zod'

/**
 * **Duplicate** of src/contracts/keys/keys.schema.ts — the self-serve
 * key contract as the admin shell uses it (issuing a brain:write key for
 * a local agent). Keep in sync; the mirror test pins the shape.
 */
export const ApiKeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  userId: z.string().optional(),
  createdAt: z.string().optional(),
  createdBy: z.string().optional(),
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
})

export const IssuedKeyResponseSchema = z.object({
  key: z.string(),
  companyId: z.string(),
  mcpUrl: z.string(),
  keyRecord: ApiKeySummarySchema,
})

export const KeyListResponseSchema = z.object({
  companyId: z.string(),
  mcpUrl: z.string(),
  keys: z.array(ApiKeySummarySchema),
  issuingEnabled: z.boolean(),
  issuableScopes: z.array(z.string()),
})

export const RevokeKeyResponseSchema = z.object({ revoked: z.boolean() })

export type IssuedKeyResponse = z.infer<typeof IssuedKeyResponseSchema>
export type KeyListResponse = z.infer<typeof KeyListResponseSchema>
