/**
 * JWT verification against inite-auth's JWKS endpoint.
 *
 * Used by:
 *   - middleware.ts — edge guard for /(en|ru)/admin/**
 *   - app/api/auth/me/route.ts — session probe
 *   - app/api/auth/callback/route.ts — token-from-OAuth-callback verify
 *
 * Audience defaults to 'brain-landing'. The auth service is expected
 * to mint admin tokens with at least `metadata.isAdmin === true` or
 * `roles.includes('admin')`. Brain backend itself sees a separate
 * static service-key (BRAIN_SERVICE_KEY) so cross-service identity
 * never has to be threaded through this layer.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

const AUTH_DOMAIN =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  'https://auth.inite.ai'

const JWKS_URL = new URL('/.well-known/jwks.json', AUTH_DOMAIN)

const EXPECTED_AUDIENCE =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

const jwks = createRemoteJWKSet(JWKS_URL)

export interface VerifiedToken extends JWTPayload {
  sub: string
  email?: string
  name?: string
  roles?: string[]
  metadata?: { isAdmin?: boolean }
}

export async function verifyAccessToken(
  token: string,
): Promise<VerifiedToken | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: EXPECTED_AUDIENCE,
      algorithms: ['RS256'],
    })
    if (!payload.sub) return null
    return payload as VerifiedToken
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[jwt-verify] Failed:', (err as Error).message)
    return null
  }
}

export function isAdminFromToken(decoded: VerifiedToken): boolean {
  return (
    decoded.roles?.includes('admin') === true ||
    decoded.metadata?.isAdmin === true
  )
}
