'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

export type EventSourceStatus = 'idle' | 'open' | 'closed'

interface StatusStore {
  get(): EventSourceStatus
  set(next: EventSourceStatus): void
  subscribe(listener: () => void): () => void
}

function createStatusStore(): StatusStore {
  let status: EventSourceStatus = 'idle'
  const listeners = new Set<() => void>()
  return {
    get: () => status,
    set: (next) => {
      if (next === status) return
      status = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const getServerStatus = (): EventSourceStatus => 'idle'

/**
 * Owns one EventSource for `url` (none while `url` is null) and exposes its
 * connection state as an external store — the browser connection is the
 * source of truth, so the status is read through useSyncExternalStore
 * rather than mirrored into React state from the effect. `onMessage`
 * always sees the latest closure. The source is closed on unmount and
 * reopened whenever `url` changes; the status is 'idle' while there is no
 * source, 'open' once one exists and 'closed' after it reported an error.
 */
export function useEventSource(
  url: string | null,
  onMessage: (data: string) => void,
): EventSourceStatus {
  const onMessageRef = useRef(onMessage)
  useEffect(() => {
    onMessageRef.current = onMessage
  })
  const [store] = useState(createStatusStore)

  useEffect(() => {
    if (!url) return
    const src = new EventSource(url)
    store.set('open')
    src.onmessage = (e: MessageEvent<string>) => onMessageRef.current(e.data)
    src.onerror = () => store.set('closed')
    return () => {
      src.close()
      store.set('idle')
    }
  }, [url, store])

  return useSyncExternalStore(store.subscribe, store.get, getServerStatus)
}
