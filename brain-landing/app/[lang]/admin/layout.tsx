'use client'

import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'
import { ReactNode } from 'react'
import {
  Activity,
  FlaskConical,
  ListChecks,
  Network,
  Presentation,
  Waypoints,
} from 'lucide-react'
import { Header } from '../../../components/Header'
import { useAuth } from '../../../hooks/useAuth'
import { normalizeLang } from '../../../lib/i18n'

interface Props {
  children: ReactNode
}

const SECTIONS = [
  { slug: 'demo', title: 'Live demo deck', icon: Presentation },
  { slug: 'playground', title: 'Playground', icon: FlaskConical },
  { slug: 'scenarios', title: 'Scenarios', icon: ListChecks },
  { slug: 'traces', title: 'Traces', icon: Waypoints },
  { slug: 'explore/graph', title: 'Explore — graph', icon: Network },
  { slug: 'explore/overview', title: 'Explore — overview', icon: Activity },
]

export default function AdminLayout({ children }: Props) {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const pathname = usePathname() ?? ''
  const auth = useAuth()

  if (!auth.loading && !auth.isAdmin) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="max-w-md text-center px-4">
          <h1 className="text-xl font-semibold text-[var(--text)]">
            Admin sign-in required
          </h1>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            This area is restricted to brain operators. Sign in through
            <code className="ml-1 text-[var(--accent)]">auth.inite.ai</code>{' '}
            with an account that has <code>metadata.isAdmin = true</code>.
          </p>
        </div>
      </div>
    )
  }

  const adminPath = pathname.replace(/^\/+(en|ru)\/admin\/?/, '')
  const currentSlug = adminPath.startsWith('explore/')
    ? adminPath.split('/').slice(0, 2).join('/')
    : adminPath.split('/')[0]

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <Header lang={lang} context="Admin" />

      <div className="max-w-7xl mx-auto px-4 md:grid md:grid-cols-[14rem_1fr] md:gap-6">
        <aside className="hidden md:block sticky top-12 self-start py-6 max-h-[calc(100vh-3rem)] overflow-y-auto">
          <nav aria-label="Admin sections" className="space-y-0.5">
            {SECTIONS.map((s) => {
              const active = currentSlug === s.slug
              const Icon = s.icon
              return (
                <Link
                  key={s.slug}
                  href={`/${lang}/admin/${s.slug}`}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                    active
                      ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {s.title}
                </Link>
              )
            })}
          </nav>
        </aside>

        <main className="py-6 min-w-0">{children}</main>
      </div>
    </div>
  )
}
