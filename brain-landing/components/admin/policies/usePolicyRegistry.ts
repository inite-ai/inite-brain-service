'use client'

import { useEffect, useState } from 'react'
import type { PolicyRegistryResponse } from '../../../lib/contracts/admin-policies'

/**
 * Fetch-once, module-cached action/attribute registry — the single
 * source of truth for every picker in the policy editor and the Key
 * Lens action matrix. The registry changes only on deploys (actions)
 * or slowly (attribute value hints), so one load per page lifetime is
 * plenty.
 */
let cached: PolicyRegistryResponse | null = null
let inFlight: Promise<PolicyRegistryResponse> | null = null

async function fetchRegistry(): Promise<PolicyRegistryResponse> {
  const res = await fetch('/api/admin/proxy/v1/admin/policy/registry', {
    cache: 'no-store',
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
  return data as PolicyRegistryResponse
}

export function usePolicyRegistry(): {
  registry: PolicyRegistryResponse | null
  error: string | null
} {
  const [registry, setRegistry] = useState<PolicyRegistryResponse | null>(cached)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (cached) return
    inFlight = inFlight ?? fetchRegistry()
    inFlight
      .then((r) => {
        cached = r
        setRegistry(r)
      })
      .catch((e) => setError((e as Error).message))
  }, [])

  return { registry, error }
}
