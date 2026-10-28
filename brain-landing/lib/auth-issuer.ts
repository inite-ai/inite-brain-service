/**
 * The `iss` a session token must carry. Signature + audience alone accept
 * any token the auth-service's keys signed for `brain-landing`; pinning the
 * issuer closes the gap the brain backend already closes with
 * AUTH_SERVICE_ISSUER (see src/auth/token-audience.ts). Both spellings, with
 * and without the trailing slash, are accepted, as on the backend.
 *
 * Shared by the Node verifier (lib/jwt-verify.ts) and the edge middleware,
 * so it imports nothing.
 */
export const DEFAULT_AUTH_ISSUER = 'https://auth-api.inite.ai'

export function acceptedIssuers(raw: string | undefined = process.env.AUTH_SERVICE_ISSUER): string[] {
  const out = new Set<string>()
  for (const entry of (raw || DEFAULT_AUTH_ISSUER).split(',')) {
    const bare = entry.trim().replace(/\/+$/, '')
    if (!bare) continue
    out.add(bare)
    out.add(`${bare}/`)
  }
  return [...out]
}
