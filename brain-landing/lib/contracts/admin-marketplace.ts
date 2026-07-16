import { z } from 'zod'

/**
 * Wire contracts for the global pack registry + marketplace surface
 * (/v1/registry reads, /v1/admin/registry writes).
 *
 * **Duplicate** of src/contracts/registry/registry.schema.ts and
 * src/contracts/registry/marketplace.schema.ts (response shapes +
 * the 402 PaymentRequiredHint).
 */

export const DisplayPriceSchema = z.object({
  /** Minor units (e.g. cents). */
  amount: z.number().int().positive(),
  /** 3-letter ISO 4217 currency code. */
  currency: z.string().regex(/^[A-Za-z]{3}$/),
})

/** One published version's discovery metadata (no manifest body). */
export const RegistryVersionSchema = z.object({
  packId: z.string(),
  version: z.string(),
  checksum: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  publisher: z.string().nullable(),
  signed: z.boolean(),
  verified: z.boolean().default(false),
  yanked: z.boolean(),
  yankReason: z.string().nullable(),
  publishedAt: z.string(),
  downloads: z.number().int().nonnegative().default(0),
  /** Upstream registry base URL when mirrored; absent = local publish. */
  origin: z.string().optional(),
})

/** One pack in a catalogue listing — latest installable version + counts. */
export const RegistryPackSummarySchema = z.object({
  packId: z.string(),
  latestVersion: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  publisher: z.string().nullable(),
  signed: z.boolean(),
  verified: z.boolean().default(false),
  downloads: z.number().int().nonnegative().default(0),
  publishedAt: z.string().optional(),
  versionCount: z.number().int().nonnegative(),
  origin: z.string().optional(),
  /** Marketplace metadata — stamped only when meaningful. */
  featured: z.boolean().optional(),
  featuredAt: z.string().optional(),
  paid: z.boolean().optional(),
  displayPrice: DisplayPriceSchema.optional(),
})

export const RegistryListResponseSchema = z.object({
  packs: z.array(RegistryPackSummarySchema),
})

export const RegistryVersionsResponseSchema = z.object({
  packId: z.string(),
  latestVersion: z.string().nullable(),
  versions: z.array(RegistryVersionSchema),
})

export const PublisherProfileSchema = z.object({
  publisher: z.string(),
  displayName: z.string(),
  url: z.string().nullable(),
  bio: z.string(),
  contactEmail: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
})

/** GET /v1/registry/publishers/:publisher — profile + catalogue entries. */
export const PublisherResponseSchema = z.object({
  publisher: z.string(),
  profile: PublisherProfileSchema.nullable(),
  packs: z.array(RegistryPackSummarySchema),
})

export const PackPricingResponseSchema = z.object({
  packId: z.string(),
  paid: z.boolean(),
  priceCode: z.string().optional(),
  displayPrice: DisplayPriceSchema.optional(),
})

export const FeatureResponseSchema = z.object({
  packId: z.string(),
  featured: z.boolean(),
})

export const YankPackResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  yanked: z.boolean(),
})

export const CheckoutResponseSchema = z.object({
  sessionId: z.string(),
  /** Hosted billing checkout URL to open. */
  checkoutUrl: z.string(),
})

/** The 402 body POST /v1/admin/packs/from-registry answers for a paid
 *  pack without an entitlement — names the checkout route to call. */
export const PaymentRequiredHintSchema = z.object({
  statusCode: z.literal(402),
  error: z.literal('Payment Required'),
  message: z.string(),
  packId: z.string(),
  priceCode: z.string().optional(),
  displayPrice: DisplayPriceSchema.optional(),
  checkout: z.object({
    method: z.literal('POST'),
    path: z.string(),
  }),
})

export type DisplayPrice = z.infer<typeof DisplayPriceSchema>
export type RegistryVersion = z.infer<typeof RegistryVersionSchema>
export type RegistryPackSummary = z.infer<typeof RegistryPackSummarySchema>
export type RegistryListResponse = z.infer<typeof RegistryListResponseSchema>
export type RegistryVersionsResponse = z.infer<
  typeof RegistryVersionsResponseSchema
>
export type PublisherProfile = z.infer<typeof PublisherProfileSchema>
export type PublisherResponse = z.infer<typeof PublisherResponseSchema>
export type PackPricingResponse = z.infer<typeof PackPricingResponseSchema>
export type FeatureResponse = z.infer<typeof FeatureResponseSchema>
export type YankPackResponse = z.infer<typeof YankPackResponseSchema>
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>
export type PaymentRequiredHint = z.infer<typeof PaymentRequiredHintSchema>
