'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface ScenarioRunMetrics {
  recallAt1: number
  recallAt5: number
  queries: number
  passes: number
  memoryAssertionsPassed: number
  memoryAssertionsTotal: number
  piiGatingPassed: number
  piiGatingTotal: number
}

export interface ScenarioRunResult {
  scenarioId: string
  passed: boolean
  durationMs: number
  companyId: string
  setupSummary: {
    facts: number
    mentions: number
    links: number
    retracts: number
    forgets: number
    errors: Array<{ step: number; kind: string; error: string }>
  }
  queryResults: Array<{
    query: string
    asOf?: string
    rankOfExpected: number
    topEntityRef: string | null
    factPredicateMatched: boolean | null
    piiGatedCorrectly: boolean | null
    mustNotLeakPredicate?: string
    passed: boolean
    topHits: Array<{
      entityId: string
      canonicalName: string
      score: number
      externalRefs: Record<string, string>
      facts: Array<{
        factId: string
        predicate: string
        object: string
        status: string
        validFrom: string
        validUntil?: string
      }>
    }>
    trace?: {
      requestId: string
      totalMs: number
      spans: Array<{
        id: string
        parentId?: string
        name: string
        startedAt: number
        durationMs?: number
        error?: string
      }>
    }
    error?: string
  }>
  memoryAssertionResults: Array<{
    description: string
    kind: string
    passed: boolean
    detail?: string
  }>
}

interface State {
  loading: boolean
  result: ScenarioRunResult | null
  error: string | null
}

/**
 * Drives the admin scenario runner from the presenter slides. Owns one
 * AbortController so an impatient speaker re-clicking Run won't pile up
 * stale promises that flash old data after the new run.
 */
export function useScenarioRun() {
  const [state, setState] = useState<State>({
    loading: false,
    result: null,
    error: null,
  })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const run = useCallback(async (scenarioId: string) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setState({ loading: true, result: null, error: null })
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/scenarios/${encodeURIComponent(scenarioId)}/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: ctrl.signal,
        },
      )
      const data = await res.json()
      if (ctrl.signal.aborted) return
      if (!res.ok) {
        setState({
          loading: false,
          result: null,
          error: data?.error ?? `${res.status} ${res.statusText}`,
        })
        return
      }
      setState({ loading: false, result: data as ScenarioRunResult, error: null })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setState({
        loading: false,
        result: null,
        error: (err as Error).message,
      })
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }, [])

  const reset = useCallback(() => {
    setState({ loading: false, result: null, error: null })
  }, [])

  return { ...state, run, reset }
}
