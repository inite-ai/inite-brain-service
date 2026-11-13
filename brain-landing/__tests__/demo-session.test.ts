/**
 * A demo session resolves to the demo persona, read-only and never an
 * admin, without any verified-email binding; the edge guard and the admin
 * BFF refuse it.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { isAdminFromToken, isDemoTenantToken } from '@/lib/jwt-verify'

vi.mock('server-only', () => ({}))

const DEMO_ORG = 'a7a71c00-de00-4000-8000-000000000001'
const demoClaims = {
  sub: 'ana-demo',
  email: 'ana@demo.invalid',
  demo: true,
  org_id: DEMO_ORG,
  org_role: 'owner',
  // Whatever else a token carries, a demo persona is never an admin.
  roles: ['admin'],
  metadata: { isAdmin: true },
}

describe('demo session', () => {
  it('a demo token is never an admin token', () => {
    expect(isAdminFromToken(demoClaims)).toBe(false)
    expect(isAdminFromToken({ sub: 'm', roles: ['admin'] })).toBe(true)
    expect(isDemoTenantToken(demoClaims)).toBe(true)
    expect(isDemoTenantToken({ ...demoClaims, org_id: 'acme' })).toBe(false)
  })

  it('getUserSession: demo, not admin; getAdminSession: none', async () => {
    vi.resetModules()
    vi.doMock('@/lib/jwt-verify', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/lib/jwt-verify')>()
      return { ...real, verifyAccessToken: vi.fn(async () => demoClaims) }
    })
    const { getUserSession, getAdminSession } = await import('@/lib/server-auth')
    const request = new NextRequest('https://brain.test/api/auth/me', {
      headers: { cookie: 'access_token=DEMO' },
    })
    const s = await getUserSession(request)
    expect(s).toMatchObject({ userId: 'ana-demo', demo: true, isAdmin: false })
    expect(await getAdminSession(request)).toBeNull()
    vi.doUnmock('@/lib/jwt-verify')
  })
})
