import Link from 'next/link'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

const REPO = 'inite-ai/inite-brain-service'

export function Footer({ lang }: Props) {
  const t = getMessages(lang)
  const f = t.footer

  const cols = [
    {
      title: f.columns.product.title,
      links: [
        { label: f.columns.product.docs, href: `/${lang}/docs` },
        { label: f.columns.product.blog, href: `/${lang}/blog` },
        { label: f.columns.product.quickstart, href: `/${lang}/docs/getting-started` },
        { label: f.columns.product.mcp, href: `/${lang}/docs/mcp/setup` },
        { label: f.columns.product.skills, href: `/${lang}/docs/skills` },
      ],
    },
    {
      title: f.columns.project.title,
      links: [
        { label: f.columns.project.github, href: `https://github.com/${REPO}`, ext: true },
        { label: f.columns.project.license, href: `https://github.com/${REPO}/blob/main/LICENSE`, ext: true },
        { label: f.columns.project.contributing, href: `https://github.com/${REPO}/blob/main/CONTRIBUTING.md`, ext: true },
        { label: f.columns.project.security, href: `https://github.com/${REPO}/blob/main/SECURITY.md`, ext: true },
      ],
    },
    {
      title: f.columns.resources.title,
      links: [
        { label: f.columns.resources.openapi, href: 'https://brain.inite.ai/openapi.json', ext: true },
        { label: f.columns.resources.status, href: 'https://brain.inite.ai/health', ext: true },
        { label: f.columns.resources.api, href: `/${lang}/docs/search`, ext: false },
      ],
    },
  ]

  return (
    <footer className="mt-12 border-t border-[var(--border)] pt-12 pb-10">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
        {/* brand */}
        <div className="col-span-2 md:col-span-1">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-[5px] border border-[var(--signal)]/60 bg-[var(--signal-faint)] flex items-center justify-center">
              <span className="w-1 h-1 rounded-full bg-[var(--signal)]" />
            </span>
            <span className="u-mono text-[12px] font-semibold tracking-[0.06em] text-[var(--text)]">
              INITE<span className="text-[var(--text-faint)]">//</span>BRAIN
            </span>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--text-faint)] max-w-[14rem]">
            {f.tagline}
          </p>
        </div>

        {cols.map((col) => (
          <div key={col.title}>
            <div className="u-eyebrow">{col.title}</div>
            <ul className="mt-3 space-y-2">
              {col.links.map((l) =>
                'ext' in l && l.ext ? (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)]"
                    >
                      {l.label}
                    </a>
                  </li>
                ) : (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)]"
                    >
                      {l.label}
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-10 pt-6 border-t border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-3 u-mono text-[11px] text-[var(--text-faint)]">
        <span>{f.copyright}</span>
        <span className="text-[var(--data)]">{f.license}</span>
      </div>
    </footer>
  )
}
