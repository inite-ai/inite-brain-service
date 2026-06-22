import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

export function SkillsInstall({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading
        index="06"
        eyebrow={t.skillsBlock.eyebrow}
        title={t.skillsBlock.title}
        subtitle={t.skillsBlock.subtitle}
      />

      <div className="mt-8 lab-panel rounded-xl overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] u-mono text-[11px] text-[var(--text-faint)]">
          shell · ~/.claude/skills/
        </div>
        <pre className="px-4 py-4 text-[12px] leading-relaxed u-mono text-[var(--text)] overflow-x-auto">
          <span className="text-[var(--text-faint)]">$ </span>
          {t.skillsBlock.installCmd}
        </pre>
      </div>

      <div className="mt-4">
        <Link
          href={`/${lang}/docs/skills`}
          className="inline-flex items-center gap-1 text-sm text-[var(--signal)] hover:underline u-mono"
        >
          {t.skillsBlock.linkLabel}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </section>
  )
}
