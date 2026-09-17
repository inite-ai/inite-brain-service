/**
 * Pack-install consent flags. A manifest may declare up to three
 * sections that change what the tenant lets the pack do, and the backend
 * gates each behind its own explicit flag (mcp-consent.ts,
 * modality-consent.ts, sources-consent.ts): a 400 whose message names
 * the flag is the ask. The gates run in this order, so an install may
 * ask up to three times; the panel accumulates what the operator
 * accepted and repeats the call with every flag so far.
 */
export const PACK_CONSENT_FLAGS = [
  'acceptMcpTools',
  'acceptModalities',
  'acceptSources',
] as const
export type PackConsentFlag = (typeof PACK_CONSENT_FLAGS)[number]

/** Which flag a 400 install error is asking for, if any. */
export function consentFlagOf(message: unknown): PackConsentFlag | null {
  if (typeof message !== 'string') return null
  for (const flag of PACK_CONSENT_FLAGS) {
    if (message.includes(`${flag}: true`)) return flag
  }
  return null
}
