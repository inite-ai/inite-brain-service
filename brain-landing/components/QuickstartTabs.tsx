'use client'

import Link from 'next/link'
import { useRef, useState, type KeyboardEvent } from 'react'
import { Check, Copy } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'
import { QUICKSTART_EXAMPLES } from '../lib/quickstart'

export function QuickstartTabs({ lang }: { lang: Lang }) {
  const t = getMessages(lang)
  const [active, setActive] = useState(0)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const copyAttempt = useRef(0)
  const current = QUICKSTART_EXAMPLES[active]

  function select(index: number) {
    copyAttempt.current++
    setActive(index)
    setCopyState('idle')
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % QUICKSTART_EXAMPLES.length
    else if (event.key === 'ArrowLeft') next = (index + QUICKSTART_EXAMPLES.length - 1) % QUICKSTART_EXAMPLES.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = QUICKSTART_EXAMPLES.length - 1
    else return
    event.preventDefault()
    select(next)
    tabs.current[next]?.focus()
  }

  async function copy() {
    const attempt = ++copyAttempt.current
    try {
      await navigator.clipboard.writeText(current.code)
      if (attempt === copyAttempt.current) setCopyState('copied')
    } catch {
      if (attempt === copyAttempt.current) setCopyState('error')
    }
  }

  return (
    <section id="quickstart" className="py-16 border-t border-[var(--border)] scroll-mt-20">
      <SectionHeading title={t.quickstart.title} subtitle={t.quickstart.subtitle} />
      <Link href={`/${lang}/docs/getting-started`} className="mt-3 min-h-11 inline-flex items-center text-sm text-[var(--data)] hover:underline">{t.quickstart.prerequisite}</Link>
      <div className="mt-5 lab-panel rounded-xl overflow-hidden">
        <div className="border-b border-[var(--border)] px-3 flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label={t.quickstart.title} className="flex gap-1">
            {QUICKSTART_EXAMPLES.map((tab, index) => (
              <button key={tab.id} ref={(el) => { tabs.current[index] = el }} type="button" role="tab"
                id={`quickstart-tab-${tab.id}`} aria-controls={`quickstart-panel-${tab.id}`}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1}
                onClick={() => select(index)} onKeyDown={(e) => onTabKey(e, index)}
                className={`min-h-11 px-3 text-sm border-b-2 transition-colors ${index === active ? 'border-[var(--signal)] text-[var(--signal)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
                {tab.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={copy} className="min-h-11 px-2 inline-flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]" aria-label={t.quickstart.copy}>
            {copyState === 'copied' ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
            <span aria-live="polite">{copyState === 'copied' ? t.quickstart.copied : t.quickstart.copy}</span>
          </button>
        </div>
        {QUICKSTART_EXAMPLES.map((tab, index) => (
          <div key={tab.id} role="tabpanel" id={`quickstart-panel-${tab.id}`} aria-labelledby={`quickstart-tab-${tab.id}`} tabIndex={0} hidden={index !== active}>
            <p className="px-5 pt-4 u-mono text-xs text-[var(--text-faint)]">{tab.filename}</p>
            <pre className="p-5 text-xs sm:text-[13px] leading-relaxed u-mono text-[var(--text)] overflow-x-auto"><code>{tab.code}</code></pre>
          </div>
        ))}
      </div>
      {copyState === 'error' && <p role="alert" className="mt-3 text-sm text-[var(--warning)]">{t.quickstart.copyError}</p>}
    </section>
  )
}
