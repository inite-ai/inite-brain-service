import { z } from 'zod';

/**
 * Wire contracts for the registry MARKETPLACE surface (docs/domain-packs.md
 * "Marketplace"): featured curation + pack pricing + publisher profiles
 * (/v1/admin/registry) and the paid-pack purchase flow (402 hint + checkout).
 *
 * Import direction: registry.schema.ts imports FROM this file (DisplayPrice,
 * PublisherProfile) — never the reverse, so the two stay cycle-free. The
 * publisher read response (which embeds pack summaries) therefore lives in
 * registry.schema.ts.
 */

/** A denormalized display price: minor units + ISO 4217 code. The billing
 *  service stays authoritative — this is discovery metadata. */
export const DisplayPriceSchema = z.object({
  amount: z.number().int().positive().describe('Minor units (e.g. cents).'),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .describe('3-letter ISO 4217 currency code.'),
});

export const SetPricingRequestSchema = z.object({
  amount: z.number().int().positive().describe('Minor units (e.g. cents).'),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
});

export const PackPricingResponseSchema = z.object({
  packId: z.string(),
  paid: z.boolean(),
  /** The active billing price code — present while the pack is paid.
   *  Re-pricing mints a new code (billing prices are immutable). */
  priceCode: z.string().optional(),
  displayPrice: DisplayPriceSchema.optional(),
});

export const FeatureResponseSchema = z.object({
  packId: z.string(),
  featured: z.boolean(),
});

/** Public profile of a registry publisher id (the key id in
 *  DOMAIN_PACK_TRUSTED_KEYS). Writable only by a company with ≥1 VERIFIED
 *  pack published under that publisher. */
export const PublisherProfileSchema = z.object({
  publisher: z.string(),
  displayName: z.string(),
  url: z.string().nullable(),
  bio: z.string(),
  contactEmail: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export const UpsertPublisherProfileRequestSchema = z.object({
  displayName: z.string().min(1).max(120),
  url: z.string().optional(),
  bio: z.string().max(2000).optional(),
  contactEmail: z.string().optional(),
});

export const CheckoutRequestSchema = z.object({
  successUrl: z.string().optional(),
  errorUrl: z.string().optional(),
});

export const CheckoutResponseSchema = z.object({
  sessionId: z.string(),
  checkoutUrl: z.string().describe('Hosted billing checkout URL to open.'),
});

/** The 402 body POST /v1/admin/packs/from-registry answers for a paid pack
 *  without an entitlement — self-describing: it names the checkout route
 *  to call, after which the install is simply retried. */
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
});

export type DisplayPrice = z.infer<typeof DisplayPriceSchema>;
export type SetPricingRequest = z.infer<typeof SetPricingRequestSchema>;
export type PackPricingResponse = z.infer<typeof PackPricingResponseSchema>;
export type FeatureResponse = z.infer<typeof FeatureResponseSchema>;
export type PublisherProfile = z.infer<typeof PublisherProfileSchema>;
export type UpsertPublisherProfileRequest = z.infer<
  typeof UpsertPublisherProfileRequestSchema
>;
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
export type PaymentRequiredHint = z.infer<typeof PaymentRequiredHintSchema>;
