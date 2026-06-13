'use client'

import { Loader2, Play, RotateCw } from 'lucide-react'

interface Props {
  loading: boolean
  hasResult: boolean
  durationMs?: number
  passed?: boolean
  onRun(): void
}

export function DemoRunButton({
  loading,
  hasResult,
  durationMs,
  passed,
  onRun,
}: Props) {
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={onRun}
        disabled={loading}
        className="inline-flex items-center gap-2 h-12 px-6 rounded-lg bg-[var(--accent)] text-white text-base font-medium disabled:opacity-50 hover:bg-[var(--accent-hover)]"
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            running…
          </>
        ) : hasResult ? (
          <>
            <RotateCw className="w-5 h-5" />
            run again
          </>
        ) : (
          <>
            <Play className="w-5 h-5" />
            run live
          </>
        )}
      </button>
      {hasResult && durationMs != null && (
        <div className="text-sm text-[var(--text-muted)]">
          {(durationMs / 1000).toFixed(1)}s ·{' '}
          <span
            className={
              passed ? 'text-[var(--accent)]' : 'text-[var(--danger)]'
            }
          >
            {passed ? 'verified' : 'failed'}
          </span>
        </div>
      )}
    </div>
  )
}
