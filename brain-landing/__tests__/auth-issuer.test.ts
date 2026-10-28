/**
 * Session tokens must carry the auth-service's issuer, not only its
 * signature and our audience. Runs the real verifier against a local key
 * set standing in for auth.inite.ai's JWKS.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWK } from 'jose'

const keys = (async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' } as JWK
  return { privateKey, set: createLocalJWKSet({ keys: [jwk] }) }
})()

vi.mock('jose', async (importOriginal) => {
  const real = await importOriginal<typeof import('jose')>()
  return {
    ...real,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<ReturnType<typeof real.createLocalJWKSet>>) =>
        (await keys).set(...args)) as unknown as ReturnType<typeof real.createRemoteJWKSet>,
  }
})

delete process.env.AUTH_SERVICE_ISSUER
process.env.OAUTH_CLIENT_ID = 'brain-landing'

let verifyAccessToken: typeof import('@/lib/jwt-verify').verifyAccessToken
let acceptedIssuers: typeof import('@/lib/auth-issuer').acceptedIssuers

beforeAll(async () => {
  ;({ verifyAccessToken } = await import('@/lib/jwt-verify'))
  ;({ acceptedIssuers } = await import('@/lib/auth-issuer'))
})

async function token(iss: string | undefined): Promise<string> {
  const { privateKey } = await keys
  let jwt = new SignJWT({ roles: ['admin'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('did:key:alice')
    .setAudience('brain-landing')
    .setExpirationTime('5m')
  if (iss) jwt = jwt.setIssuer(iss)
  return jwt.sign(privateKey)
}

describe('session token issuer', () => {
  it('accepts the auth-service issuer, with or without the slash', async () => {
    expect(await verifyAccessToken(await token('https://auth-api.inite.ai'))).not.toBeNull()
    expect(await verifyAccessToken(await token('https://auth-api.inite.ai/'))).not.toBeNull()
  })

  it('refuses a token signed by the same keys under another issuer', async () => {
    expect(await verifyAccessToken(await token('http://localhost:3002'))).toBeNull()
    expect(await verifyAccessToken(await token('https://evil.example'))).toBeNull()
  })

  it('refuses a token with no issuer', async () => {
    expect(await verifyAccessToken(await token(undefined))).toBeNull()
  })

  it('AUTH_SERVICE_ISSUER overrides the default', () => {
    expect(acceptedIssuers('https://auth.staging.test/')).toEqual([
      'https://auth.staging.test',
      'https://auth.staging.test/',
    ])
  })
})
