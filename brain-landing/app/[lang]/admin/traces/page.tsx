'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Radio, RefreshCw } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { normalizeLang } from '../../../../lib/i18n'
import type { TraceListItem as TraceMeta } from '../../../../lib/contracts/admin-traces'

export default function TracesListPage() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const [traces, setTraces] = useState<TraceMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(true)
  const [sseStatus, setSseStatus] = useState<'idle' | 'open' | 'closed'>('idle')
  const [q, setQ] = useState('')
  const [methodFilter, setMethodFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'err'>('all')
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/traces')
      const data = await res.json()
      if (data?.error) throw new Error(data.error)
      setTraces(data.traces ?? [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!live) {
      setSseStatus('idle')
      return
    }
    const url = '/api/admin/sse/v1/admin/traces/stream'
    const src = new EventSource(url)
    setSseStatus('open')
    src.onmessage = (e) => {
      try {
        const meta = JSON.parse(e.data) as TraceMeta
        setTraces((prev) => {
          if (prev.some((p) => p.requestId === meta.requestId)) return prev
          return [meta, ...prev].slice(0, 500)
        })
      } catch {
        // tolerate malformed frames
      }
    }
    src.onerror = () => {
      setSseStatus('closed')
    }
    return () => {
      src.close()
      setSseStatus('idle')
    }
  }, [live])

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (statusFilter === 'ok' && t.status >= 400) return false
      if (statusFilter === 'err' && t.status < 400) return false
      if (methodFilter && t.method !== methodFilter) return false
      if (
        q &&
        !t.path.toLowerCase().includes(q.toLowerCase()) &&
        !t.requestId.toLowerCase().includes(q.toLowerCase())
      )
        return false
      return true
    })
  }, [traces, q, methodFilter, statusFilter])

  const methods = useMemo(
    () => Array.from(new Set(traces.map((t) => t.method))).sort(),
    [traces],
  )

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-base font-semibold text-[var(--text)]">Traces</h1>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          refresh
        </button>
        <label className="text-xs text-[var(--text-muted)] flex items-center gap-1">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          live (SSE)
          <span
            className={`ml-1 inline-block w-1.5 h-1.5 rounded-full ${
              sseStatus === 'open'
                ? 'bg-[var(--success)]'
                : sseStatus === 'closed'
                  ? 'bg-[var(--danger)]'
                  : 'bg-[var(--text-faint)]'
            }`}
          />
        </label>
        <span className="ml-auto text-xs text-[var(--text-faint)]">
          {filtered.length} shown / {traces.length} captured
        </span>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter path / requestId"
          className="flex-1 max-w-xs border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--text)]"
        />
        <select
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value)}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--text)]"
        >
          <option value="">all methods</option>
          {methods.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="flex border border-[var(--border)] rounded-md overflow-hidden text-[10px]">
          {(['all', 'ok', 'err'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-2 py-1 border-r border-[var(--border)] last:border-r-0 ${
                statusFilter === s
                  ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[var(--text-faint)] flex items-center gap-1">
          <Radio className="w-3 h-3" /> SSE pushes new traces as they land.
        </span>
      </div>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] grid grid-cols-[6rem_4rem_1fr_4rem_5rem_8rem] gap-2 px-2 py-1 border-b border-[var(--border)]">
        <span>time</span>
        <span>method</span>
        <span>path</span>
        <span>status</span>
        <span className="text-right">ms</span>
        <span>tenant</span>
      </div>

      <div
        ref={scrollRef}
        className="h-[60vh] overflow-auto border border-[var(--border)] rounded-md"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const t = filtered[virtualRow.index]
            return (
              <div
                key={t.requestId}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="grid grid-cols-[6rem_4rem_1fr_4rem_5rem_8rem] gap-2 px-2 py-1 text-xs hover:bg-[var(--bg-overlay)]/40 border-b border-[var(--border)]/40"
              >
                <span className="font-mono text-[10px] text-[var(--text-faint)] truncate">
                  {new Date(t.ts).toLocaleTimeString()}
                </span>
                <span className="font-mono text-[var(--text-muted)] truncate">
                  {t.method}
                </span>
                <span className="font-mono truncate">
                  <Link
                    href={`/${lang}/admin/traces/${t.requestId}`}
                    className="text-[var(--accent)] hover:underline"
                  >
                    {t.path}
                  </Link>
                </span>
                <span
                  className={`font-mono ${
                    t.status >= 400
                      ? 'text-[var(--danger)]'
                      : 'text-[var(--text)]'
                  }`}
                >
                  {t.status}
                </span>
                <span className="font-mono text-right tabular-nums">
                  {t.durationMs}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-muted)] truncate">
                  {t.companyId ?? '-'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {!loading && traces.length === 0 && (
        <div className="text-xs text-[var(--text-faint)] italic py-4">
          No traces yet. Submit something via Playground to see them.
        </div>
      )}
    </div>
  )
}
