'use client'

interface Props {
  kinds: string[]
  selected: Set<string>
  onToggle(kind: string): void
  onClear(): void
}

export function PredicateFilter({
  kinds,
  selected,
  onToggle,
  onClear,
}: Props) {
  if (kinds.length === 0) return null
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mr-1">
        edges:
      </span>
      {kinds.map((k) => {
        const on = selected.has(k)
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggle(k)}
            className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors ${
              on
                ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'
            }`}
          >
            {k}
          </button>
        )
      })}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] text-[var(--text-faint)] hover:text-[var(--text-muted)] ml-1"
        >
          clear
        </button>
      )}
    </div>
  )
}
