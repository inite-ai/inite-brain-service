'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IntroSlide } from '../../../../components/demo/IntroSlide'
import { BitemporalSlide } from '../../../../components/demo/BitemporalSlide'
import { RetractSlide } from '../../../../components/demo/RetractSlide'
import { ForgetSlide } from '../../../../components/demo/ForgetSlide'
import { PiiSlide } from '../../../../components/demo/PiiSlide'
import { OutroSlide } from '../../../../components/demo/OutroSlide'

const SLIDES = [
  { id: 'intro', component: <IntroSlide /> },
  { id: 'bitemporal', component: <BitemporalSlide /> },
  { id: 'retract', component: <RetractSlide /> },
  { id: 'forget', component: <ForgetSlide /> },
  { id: 'pii', component: <PiiSlide /> },
  { id: 'outro', component: <OutroSlide /> },
]

export default function DemoPage() {
  const [idx, setIdx] = useState(0)

  const next = useCallback(
    () => setIdx((i) => Math.min(SLIDES.length - 1, i + 1)),
    [],
  )
  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return
      if (e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault()
        next()
      } else if (
        e.key === 'ArrowLeft' ||
        e.key === 'Backspace' ||
        e.key === 'PageUp'
      ) {
        e.preventDefault()
        prev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev])

  const slide = SLIDES[idx]

  return (
    <div className="min-h-screen bg-[var(--bg)] -my-6">
      <div className="key-slide">{slide.component}</div>

      <nav
        aria-label="slide navigation"
        className="fixed bottom-6 right-6 flex items-center gap-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-full px-2 py-1 shadow-lg"
      >
        <button
          type="button"
          onClick={prev}
          disabled={idx === 0}
          aria-label="previous slide"
          className="p-1.5 rounded-full disabled:opacity-30 hover:bg-[var(--bg-overlay)]"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="px-2 text-xs font-mono text-[var(--text-muted)]">
          {idx + 1}/{SLIDES.length}
        </span>
        <button
          type="button"
          onClick={next}
          disabled={idx === SLIDES.length - 1}
          aria-label="next slide"
          className="p-1.5 rounded-full disabled:opacity-30 hover:bg-[var(--bg-overlay)]"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <div className="ml-2 flex gap-1">
          {SLIDES.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setIdx(i)}
              aria-label={`go to slide ${i + 1}`}
              className={`w-1.5 h-1.5 rounded-full ${
                i === idx
                  ? 'bg-[var(--accent)]'
                  : 'bg-[var(--border)] hover:bg-[var(--text-faint)]'
              }`}
            />
          ))}
        </div>
      </nav>
    </div>
  )
}
