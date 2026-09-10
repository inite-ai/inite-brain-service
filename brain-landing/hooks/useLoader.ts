'use client'

import { useCallback, useEffect, useState } from 'react'

type Load<A extends unknown[]> = ((...args: A) => Promise<unknown>) &
  (() => Promise<unknown>)

/**
 * Drives a fetch-into-state function from the component lifecycle without
 * writing state inside the effect. `load` runs whenever its identity
 * changes (memoise it on the inputs it reads); `reload` runs it from an
 * event — button, interval, after a mutation — and resolves when it has
 * settled. `loading` is derived during render: true from mount, or from the
 * moment `load` changed or `reload` was called, until that exact run has
 * settled, so a slow earlier request can never clear the indicator while a
 * newer one is still in flight. `load` is expected to route its own
 * failures into state; a rejection surfaces exactly as `void load()` would.
 */
export function useLoader<A extends unknown[] = []>(
  load: Load<A>,
): { loading: boolean; reload: (...args: A) => Promise<void> } {
  const [settled, setSettled] = useState<{ load: Load<A> } | null>(null)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    let current = true
    void load().finally(() => {
      if (current) setSettled({ load })
    })
    return () => {
      current = false
    }
  }, [load])

  const reload = useCallback(
    async (...args: A) => {
      setPending((n) => n + 1)
      try {
        await load(...args)
      } finally {
        setPending((n) => n - 1)
      }
    },
    [load],
  )

  return { loading: settled?.load !== load || pending > 0, reload }
}
