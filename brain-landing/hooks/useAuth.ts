'use client'

import { useEffect, useState } from 'react'

export interface AuthState {
  loading: boolean
  isAdmin: boolean
  userId: string | null
  email: string | null
}

const INITIAL: AuthState = {
  loading: true,
  isAdmin: false,
  userId: null,
  email: null,
}

/**
 * Client hook that reads the current admin session from
 * `/api/auth/me`. The endpoint is the canonical place where the
 * cookie → JWT → admin check happens; the client just renders the
 * shape. Returns `{ loading, isAdmin, userId, email }`.
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
          setState({
            loading: false,
            isAdmin: false,
            userId: null,
            email: null,
          })
          return
        }
        setState({
          loading: false,
          isAdmin: Boolean(data.isAdmin),
          userId: data.userId ?? null,
          email: data.email ?? null,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            loading: false,
            isAdmin: false,
            userId: null,
            email: null,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
