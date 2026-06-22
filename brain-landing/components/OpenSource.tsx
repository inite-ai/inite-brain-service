import { Scale, BookOpen, ShieldCheck, GitPullRequest, Star, ArrowRight } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

const REPO = 'inite/inite-brain-service'

// Tech names aren't localized — they're proper nouns.
const STACK = [
  'NestJS 11',
  'TypeScript',
  'SurrealDB 2.3',
  'BGE-M3 · 1024d',
  'OpenAI',
  'Cohere Rerank',
  'OpenTelemetry',
  'Docker',
  'Node 22',
]

export function OpenSource({ lang }: Props) {
  const t = getMessages(lang)
  const links = [
    { icon: BookOpen, label: t.openSource.links.readme, href: `https://github.com/${REPO}#readme` },
    { icon: GitPullRequest, label: t.openSource.links.contributing, href: `https://github.com/${REPO}/blob/main/CONTRIBUTING.md` },
    { icon: ShieldCheck, label: t.openSource.links.security, href: `https://github.com/${REPO}/blob/main/SECURITY.md` },
    { icon: Scale, label: t.openSource.links.license, href: `https://github.com/${REPO}/blob/main/LICENSE` },
  ]
  return (
    <section id="open-source" className="py-16 border-t border-[var(--border)] scroll-mt-20">
      <SectionHeading
        index="07"
        eyebrow={t.openSource.eyebrow}
        title={t.openSource.title}
        subtitle={t.openSource.subtitle}
      />

      <div className="mt-8 grid lg:grid-cols-3 gap-4">
        {/* license + links */}
        <div className="lab-panel rounded-xl p-6 lg:col-span-2">
          <div className="flex items-center gap-3">
            <span className="px-2 py-1 rounded u-mono text-[11px] border border-[var(--data)]/40 bg-[var(--data-faint)] text-[var(--data)]">
              AGPL-3.0
            </span>
            <span className="u-mono text-[11px] text-[var(--text-faint)]">
              {t.openSource.license.note}
            </span>
          </div>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {links.map(({ icon: Icon, label, href }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 hover:border-[var(--signal)]/40 transition-colors"
              >
                <span className="flex items-center gap-2 text-[13px] text-[var(--text-muted)] group-hover:text-[var(--text)]">
                  <Icon className="w-4 h-4 text-[var(--signal)]" />
                  {label}
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-[var(--text-faint)] group-hover:text-[var(--signal)] -translate-x-1 group-hover:translate-x-0 transition-transform" />
              </a>
            ))}
          </div>

          <div className="mt-6">
            <div className="u-eyebrow">{t.openSource.stack.label}</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {STACK.map((s) => (
                <span
                  key={s}
                  className="u-mono text-[11px] rounded-md border border-[var(--border)] bg-[var(--bg-overlay)]/50 px-2 py-1 text-[var(--text-muted)]"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* star CTA */}
        <div className="lab-panel rounded-xl p-6 flex flex-col justify-between bg-[radial-gradient(120%_80%_at_100%_0%,var(--signal-faint),transparent)]">
          <div>
            <Star className="w-6 h-6 text-[var(--signal)]" />
            <h3 className="u-display mt-4 text-lg font-semibold text-[var(--text)]">
              {t.openSource.cta.title}
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {t.openSource.cta.desc}
            </p>
          </div>
          <a
            href={`https://github.com/${REPO}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-signal mt-5 h-10 px-4 inline-flex items-center justify-center gap-1.5 rounded-md text-sm"
          >
            <Star className="w-4 h-4" />
            {t.openSource.cta.button}
          </a>
        </div>
      </div>
    </section>
  )
}
