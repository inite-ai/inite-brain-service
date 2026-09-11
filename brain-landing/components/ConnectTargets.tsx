'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'
import { CONNECT_TARGETS, type ConnectTarget } from '../lib/connect-targets'

/**
 * Where Brain can be installed, and how far one click actually gets you.
 *
 * Two kinds of row, and the difference is the point: Cursor and VS Code
 * publish real `…://mcp/install` URL schemes, so those are buttons that
 * do the work. Everyone else does not have one — Claude Code and Gemini
 * CLI install from a command, Claude Desktop and ChatGPT from their own
 * UI — so those rows hand over the exact string to paste instead of
 * pretending a button exists. A button that opens a settings page and
 * leaves the user to it is worse than a copy field that finishes the
 * job.
 */
export function ConnectTargets({ lang }: { lang: Lang }) {
  const t = getMessages(lang)
  const [copied, setCopied] = useState<string | null>(null)

  async function copy(target: ConnectTarget) {
    if (!target.copy) return
    try {
      await navigator.clipboard.writeText(target.copy)
      setCopied(target.id)
      setTimeout(() => setCopied((was) => (was === target.id ? null : was)), 2000)
    } catch {
      // Clipboard denied (insecure context, permissions). The string is
      // on screen and selectable — say nothing rather than flash an error.
    }
  }

  return (
    <section id="connect" className="py-16 border-t border-[var(--border)] scroll-mt-20">
      <SectionHeading title={t.connectBlock.title} subtitle={t.connectBlock.subtitle} />

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {CONNECT_TARGETS.map((target) => (
          <div
            key={target.id}
            className="lab-panel rounded-xl p-4 flex flex-col gap-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-[var(--text)]">{target.label}</h3>
              <span className="u-mono text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
                {t.connectBlock.kind[target.kind]}
              </span>
            </div>

            {target.href ? (
              <a
                href={target.href}
                className="btn-signal min-h-11 px-3 inline-flex items-center justify-center gap-2 rounded-md text-sm"
              >
                {t.connectBlock.addTo.replace('{client}', target.label)}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}

            {target.copy ? (
              <div className="flex items-stretch gap-2">
                <code className="flex-1 min-w-0 u-mono text-[11px] leading-relaxed text-[var(--data)] bg-[var(--surface-2,transparent)] rounded px-2 py-2 overflow-x-auto whitespace-pre">
                  {target.copy}
                </code>
                <button
                  type="button"
                  onClick={() => void copy(target)}
                  aria-label={t.connectBlock.copy}
                  className="min-h-11 px-2 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  {copied === target.id ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  <span aria-live="polite">
                    {copied === target.id ? t.connectBlock.copied : t.connectBlock.copy}
                  </span>
                </button>
              </div>
            ) : null}

            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              {t.connectBlock.notes[target.id]}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-[var(--text-faint)]">
        {t.connectBlock.keyHint}{' '}
        <Link href={`/${lang}/app/keys`} className="text-[var(--signal)] hover:underline">
          {t.connectBlock.keyLink}
        </Link>
        {' · '}
        <Link href={`/${lang}/docs/mcp/setup`} className="text-[var(--signal)] hover:underline">
          {t.connectBlock.allClients}
        </Link>
      </p>
    </section>
  )
}
