import { NextRequest, NextResponse } from 'next/server'
import { getAdminSession } from '@/lib/server-auth'

/**
 * GET /api/auth/me
 *
 * Returns the current admin session (verified via JWT). Used by the
 * client `useAuth` hook + Header.tsx to decide whether to show the
 * "Admin" nav link. Returns 200 with `{ isAdmin: false }` when no
 * session — never 401 — so the hook can branch cleanly.
 */
export async function GET(request: NextRequest) {
  const session = await getAdminSession(request)
  if (!session) {
    return NextResponse.json({ isAdmin: false }, { status: 200 })
  }
  return NextResponse.json({
    userId: session.userId,
    email: session.email,
    isAdmin: true,
  })
}
