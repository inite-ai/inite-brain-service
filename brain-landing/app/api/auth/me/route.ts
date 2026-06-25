import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/server-auth'

/**
 * GET /api/auth/me
 *
 * Returns the current session (verified via JWT). Used by the client
 * `useAuth` hook + Header.tsx to decide whether to show the "Admin" nav
 * link, and by the end-user app shell to gate on "is logged in".
 *
 * Resolves via {@link getUserSession} so a logged-in non-admin is
 * distinguishable from an anonymous visitor: anonymous →
 * `{ isAuthenticated: false, isAdmin: false }`, logged-in user →
 * `{ isAuthenticated: true, isAdmin: <bool> }`. Always 200 (never 401)
 * so the hook can branch cleanly.
 */
export async function GET(request: NextRequest) {
  const session = await getUserSession(request)
  if (!session) {
    return NextResponse.json(
      { isAuthenticated: false, isAdmin: false },
      { status: 200 },
    )
  }
  return NextResponse.json({
    isAuthenticated: true,
    userId: session.userId,
    email: session.email,
    isAdmin: session.isAdmin,
  })
}
