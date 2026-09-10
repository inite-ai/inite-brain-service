import { z } from 'zod';

/**
 * Self-serve API keys — the contract the app's Keys screen and any
 * scripted provisioning share.
 *
 * Only the four user-delegable scopes appear here. The hosting-operator
 * scopes (`brain:platform_admin`, `brain:read_media`, `registry:*`,
 * `indexer:write`) are deliberately absent: they are granted through
 * operator configuration and must never be mintable through a token or a
 * key, which is the same rule the JWKS VALID_SCOPES set enforces.
 */
export const IssuableScopeSchema = z.enum([
  'brain:read',
  'brain:write',
  'brain:admin',
  'brain:read_pii',
]);

export const IssueKeyRequestSchema = z.object({
  /** Human label, shown in listings. */
  name: z.string().min(1).max(80),
  /** Requested scopes, narrowed server-side to what the caller already holds. */
  scopes: z.array(IssuableScopeSchema).min(1),
  /** Optional lifetime. Absent = no expiry. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /**
   * Bind the key to an end user, so memory written through it is scoped
   * the way that user's session would be. Defaults to the caller's own
   * userId when the caller is user-bound.
   */
  userId: z.string().min(1).max(200).optional(),
});

export const ApiKeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First characters of the plaintext — recognisable, not usable. */
  prefix: z.string(),
  scopes: z.array(z.string()),
  userId: z.string().optional(),
  createdAt: z.string().optional(),
  createdBy: z.string().optional(),
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
});

/** The issuing response — the only place the plaintext ever appears. */
export const IssuedKeyResponseSchema = z.object({
  key: z.string(),
  companyId: z.string(),
  mcpUrl: z.string(),
  keyRecord: ApiKeySummarySchema,
});

export const KeyListResponseSchema = z.object({
  companyId: z.string(),
  mcpUrl: z.string(),
  keys: z.array(ApiKeySummarySchema),
  /** False when this deployment has no database-backed key store. */
  issuingEnabled: z.boolean(),
  /** Scopes this caller may grant — its own, minus the non-delegable ones. */
  issuableScopes: z.array(z.string()),
});

export const RevokeKeyResponseSchema = z.object({ revoked: z.boolean() });

export type IssuableScope = z.infer<typeof IssuableScopeSchema>;
export type ApiKeySummaryContract = z.infer<typeof ApiKeySummarySchema>;
export type IssuedKeyResponse = z.infer<typeof IssuedKeyResponseSchema>;
export type KeyListResponse = z.infer<typeof KeyListResponseSchema>;
export type RevokeKeyResponse = z.infer<typeof RevokeKeyResponseSchema>;
