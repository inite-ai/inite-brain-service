'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useEffect, useRef, useState } from 'react'
import { Crosshair } from 'lucide-react'
import type {
  PolicyRule,
  PreviewRuleResponse,
} from '../../../lib/contracts/admin-policies'

/**
 * Debounced live match count for one source rule — the single line
 * that makes the builder trustworthy: "this rule currently matches
 * ~N of the M most recent facts". Sampled server-side (≤5k recent
 * active facts), so it's an estimate, not an audit.
 */
export function RuleMatchPreview({ rule }: { rule: PolicyRule }) {
  const [preview, setPreview] = useState<PreviewRuleResponse | null>(null)
  const [pending, setPending] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ready =
    rule.kind === 'source' &&
    rule.id.trim().length > 0 &&
    (rule.match ?? []).length > 0 &&
    (rule.match ?? []).every((c) => {
      if (c.op === 'exists' || c.op === 'not_exists') return true
      if (c.value === undefined || c.value === '') return false
      if (Array.isArray(c.value) && c.value.length === 0) return false
      return true
    })

  const signature = JSON.stringify({ m: rule.match, e: rule.effect, i: rule.id })

  useEffect(() => {
    if (!ready) {
      setPreview(null)
      return
    }
    setPending(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            '/api/admin/proxy/v1/admin/policy/preview-rule',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ rule }),
            },
          )
          const data = await res.json()
          if (res.ok) setPreview(data as PreviewRuleResponse)
        } catch {
          /* preview is best-effort — silence transport hiccups */
        } finally {
          setPending(false)
        }
      })()
    }, 600)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ready])

  if (!ready) return null

  const pct =
    preview && preview.sampled > 0
      ? Math.round((preview.matched / preview.sampled) * 100)
      : 0

  return (
    <div className="mt-1.5 flex items-center justify-end gap-1 text-[10px] font-mono text-[var(--text-muted)]">
      <Crosshair className="h-2.5 w-2.5" />
      {pending || !preview ? (
        <span className="animate-pulse">counting…</span>
      ) : (
        <span
          title={
            preview.sample.length > 0
              ? `e.g. ${preview.sample
                  .map((s) => `${s.predicate} (${s.source.vertical ?? '—'})`)
                  .join(' · ')}`
              : undefined
          }
        >
          ~{preview.matched} of {preview.sampled} recent facts match ({pct}%)
        </span>
      )}
    </div>
  )
}
