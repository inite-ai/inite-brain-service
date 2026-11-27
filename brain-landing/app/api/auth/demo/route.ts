import { NextRequest } from 'next/server'
import { demoSignIn } from '@/lib/demo-signin'

/** The demo door: see lib/demo-signin.ts. Off unless DEMO_ENABLED=1. */
export async function GET(request: NextRequest) {
  return demoSignIn(request)
}

export const POST = GET
