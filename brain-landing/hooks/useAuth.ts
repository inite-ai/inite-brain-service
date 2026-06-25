'use client'

import { useEffect, useState } from 'react'

export interface AuthState {
  loading: boolean
  isAuthenticated: boolean
  isAdmin: boolean
  userId: string | null
  email: string | null
}

const INITIAL: AuthState = {
  loading: true,
  isAuthenticated: false,
  isAdmin: false,
  userId: null,
  email: null,
}

const ANON: AuthState = { ...INITIAL, loading: false }

/**
 * Client hook that reads the current session from `/api/auth/me`. The
 * endpoint is the canonical place where the cookie → JWT check happens;
 * the client just renders the shape. Returns `{ loading, isAuthenticated,
 * isAdmin, userId, email }`. `isAuthenticated` distinguishes a logged-in
 * non-admin (app shell gate) from an anonymous visitor; `isAdmin` gates
 * admin-only affordances.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>(INITIAL)

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (!data) {
          setState(ANON)
          return
        }
        setState({
          loading: false,
          isAuthenticated: Boolean(data.isAuthenticated),
          isAdmin: Boolean(data.isAdmin),
          userId: data.userId ?? null,
          email: data.email ?? null,
        })
      })
      .catch(() => {
        if (!cancelled) setState(ANON)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
