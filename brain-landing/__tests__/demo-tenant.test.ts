/**
 * The demo tenant's ids are the family's (inite-auth-service
 * src/organizations/demo-tenant.ts, inite-shared @inite/auth/demo). This
 * public repo pins them in lib/demo-tenant.ts; the engine pins the same in
 * src/demo/demo-tenant.ts. A drift points the demo at a tenant nobody signs
 * in to.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEMO_ORG_ID,
  DEMO_ORG_NAME,
  DEMO_ORG_ROLES,
  DEMO_ORG_SLUG,
  demoEndsAt,
  demoPersona,
  isDemoOrgId,
} from '@/lib/demo-tenant'

describe('demo tenant pin', () => {
  it('is the family demo org', () => {
    expect(DEMO_ORG_ID).toBe('a7a71c00-de00-4000-8000-000000000001')
    expect(DEMO_ORG_SLUG).toBe('demo')
    expect(DEMO_ORG_NAME).toBe('Atlântica Group (demo)')
    expect(DEMO_ORG_ROLES).toEqual({ owner: 'owner', manager: 'admin', staff: 'member' })
  })

  it('the engine pins the same id', () => {
    const engine = fs.readFileSync(path.join(process.cwd(), '..', 'src', 'demo', 'demo-tenant.ts'), 'utf8')
    expect(engine).toContain(`'${DEMO_ORG_ID}'`)
  })

  it('reads personas, the org id and the demo end strictly', () => {
    expect(demoPersona('owner')).toBe('owner')
    expect(demoPersona('demo:staff')).toBe('staff')
    expect(demoPersona('admin')).toBeNull()
    expect(demoPersona(undefined)).toBeNull()
    expect(isDemoOrgId(DEMO_ORG_ID)).toBe(true)
    expect(isDemoOrgId('demo')).toBe(false)
    expect(demoEndsAt('1')).toBeNull()
    expect(demoEndsAt('1900000000')?.getTime()).toBe(1_900_000_000_000)
  })
})
