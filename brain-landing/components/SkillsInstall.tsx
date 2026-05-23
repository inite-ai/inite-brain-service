import Link from 'next/link'
import { ArrowRight, Terminal } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

export function SkillsInstall({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-12 border-t border-[var(--border)]">
      <h2 className="text-lg font-semibold text-[var(--text)] tracking-tight flex items-center gap-2">
        <Terminal className="w-4 h-4 text-[var(--accent)]" />
        {t.skillsBlock.title}
      </h2>
      <p className="mt-2 text-sm text-[var(--text-muted)] max-w-2xl">
        {t.skillsBlock.subtitle}
      </p>

      <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] text-[11px] font-mono text-[var(--text-faint)]">
          shell · ~/.claude/skills/
        </div>
        <pre className="px-4 py-4 text-[12px] leading-relaxed font-mono text-[var(--text)] overflow-x-auto">
          {t.skillsBlock.installCmd}
        </pre>
      </div>

      <div className="mt-4">
        <Link
          href={`/${lang}/docs/skills`}
          className="text-sm text-[var(--accent)] hover:underline inline-flex items-center gap-1"
        >
          {t.skillsBlock.linkLabel}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </section>
  )
}
