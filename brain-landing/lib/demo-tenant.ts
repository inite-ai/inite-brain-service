/**
 * The INITE family's one demo tenant and its personas, as the landing
 * needs them for `/api/auth/demo`.
 *
 * Source of truth: inite-auth-service `src/organizations/demo-tenant.ts`
 * and inite-shared `packages/auth/src/kit/demo.ts` (`@inite/auth/demo`).
 * This repo is public and takes no private package, so the values are
 * pinned here once; `__tests__/demo-tenant.test.ts` pins them and fails if
 * this file and the engine's `src/demo/demo-tenant.ts` drift apart.
 */
export const DEMO_ORG_ID = 'a7a71c00-de00-4000-8000-000000000001'
export const DEMO_ORG_SLUG = 'demo'
export const DEMO_ORG_NAME = 'Atlântica Group (demo)'

/** Ana (owner), Bruno (org admin), Carla (member). Never a platform admin. */
export const DEMO_PERSONAS = ['owner', 'manager', 'staff'] as const
export type DemoPersona = (typeof DEMO_PERSONAS)[number]

export const DEMO_ORG_ROLES: Readonly<Record<DemoPersona, 'owner' | 'admin' | 'member'>> = {
  owner: 'owner',
  manager: 'admin',
  staff: 'member',
}

/** The RFC 8693 demo grant auth.inite.ai answers (auth-service #276). */
export const DEMO_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const DEMO_SUBJECT_TOKEN_TYPE = 'urn:inite:params:oauth:token-type:demo-persona'

/** The readable cookie holding the demo's end, in Unix seconds (the banner reads it). */
export const DEMO_SESSION_COOKIE = 'demo_session'

/** `owner` or `demo:owner` → `owner`; anything else → null. */
export function demoPersona(value: string | null | undefined): DemoPersona | null {
  const v = (value ?? '').trim().toLowerCase().replace(/^demo:/, '')
  return (DEMO_PERSONAS as readonly string[]).includes(v) ? (v as DemoPersona) : null
}

export function isDemoOrgId(id: unknown): boolean {
  return id === DEMO_ORG_ID
}

/** The demo is off unless the deployment sets DEMO_ENABLED=1. */
export function demoEnabled(): boolean {
  return process.env.DEMO_ENABLED === '1'
}

/** The demo's end from the cookie value, or null when it is not a time. */
export function demoEndsAt(cookieValue: string | null | undefined): Date | null {
  const n = Number(cookieValue)
  return Number.isFinite(n) && n > 1_000_000_000 ? new Date(n * 1000) : null
}
