'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'
import { ReactNode, useState } from 'react'
import {
  BarChart3,
  GitCompareArrows,
  KeyRound,
  Menu,
  Network,
  Search,
  Boxes,
  History,
  FlaskConical,
  Users,
  UserRound,
  X,
} from 'lucide-react'
import { Header } from '../../../components/Header'
import { ShellNav, type ShellGroup } from '../../../components/ShellNav'
import { ProxyBaseProvider } from '../../../components/playground/usePlaygroundCall'
import { useAuth } from '../../../hooks/useAuth'
import { normalizeLang } from '../../../lib/i18n'

/** End-user pages route all brain calls through the reduced-scope BFF. */
const APP_PROXY_BASE = '/api/app/proxy'

interface Props {
  children: ReactNode
}

// Two-section product shell: a memory Explorer for everyone, and a
// Develop console for technical users. Mirrors the admin layout's
// nav/mobile-drawer structure but routes under /[lang]/app/*.
const GROUPS: ShellGroup[] = [
  {
    label: 'Explore',
    items: [
      { slug: 'search', title: 'Search & Ask', icon: Search },
      { slug: 'entities', title: 'Entities', icon: Boxes },
      { slug: 'graph', title: 'Knowledge graph', icon: Network },
      { slug: 'timeline', title: 'Timeline', icon: History },
      { slug: 'review', title: 'Conflicts', icon: GitCompareArrows },
      { slug: 'communities', title: 'Communities', icon: Users },
    ],
  },
  {
    label: 'Develop',
    items: [
      { slug: 'playground', title: 'Playground', icon: FlaskConical },
      { slug: 'keys', title: 'Keys & integrations', icon: KeyRound },
      { slug: 'usage', title: 'Usage', icon: BarChart3 },
    ],
  },
]

export default function AppLayout({ children }: Props) {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const pathname = usePathname() ?? ''
  const auth = useAuth()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  if (!auth.loading && !auth.isAuthenticated) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="max-w-md text-center px-4">
          <h1 className="text-xl font-semibold text-[var(--text)]">
            Sign-in required
          </h1>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Sign in through
            <code className="mx-1 text-[var(--accent)]">auth.inite.ai</code>
            to explore your brain.
          </p>
          <Link
            href={`/api/auth/login?return_url=${encodeURIComponent(
              pathname || `/${lang}/app/search`,
            )}`}
            className="mt-4 inline-block px-4 py-2 rounded-md text-sm bg-[var(--accent)] text-white"
          >
            Sign in
          </Link>
        </div>
      </div>
    )
  }

  const appPath = pathname.replace(/^\/+(en|ru)\/app\/?/, '')
  const currentSlug = appPath.split('/')[0]
  const closeNav = () => setMobileNavOpen(false)

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <Header lang={lang} context="Brain" />

      <div className="border-b border-[var(--border)] bg-[var(--bg-elevated)]/60 backdrop-blur sticky top-12 z-20">
        <div className="max-w-7xl mx-auto px-4 h-10 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="md:hidden p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-overlay)]"
            aria-label="Open navigation"
          >
            <Menu className="w-4 h-4" />
          </button>
          <span className="font-mono text-[var(--text-muted)]">Memory</span>
          <div className="ml-auto flex items-center gap-2 text-[var(--text-muted)]">
            {auth.email && (
              <span className="hidden sm:flex items-center gap-1">
                <UserRound className="w-3 h-3 text-[var(--text-faint)]" />
                <span className="font-mono">{auth.email}</span>
              </span>
            )}
            {auth.isAdmin && (
              <Link
                href={`/${lang}/admin/explore/overview`}
                className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--accent)]/10 text-[var(--accent)]"
              >
                admin
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 md:grid md:grid-cols-[14rem_1fr] md:gap-6">
        <aside className="hidden md:block sticky top-[5.5rem] self-start py-6 max-h-[calc(100vh-5.5rem)] overflow-y-auto">
          <ShellNav
            groups={GROUPS}
            currentSlug={currentSlug}
            hrefFor={(slug) => `/${lang}/app/${slug}`}
            onNavigate={closeNav}
            ariaLabel="Memory sections"
          />
        </aside>

        {mobileNavOpen && (
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/60 flex"
            onClick={closeNav}
          >
            <aside
              className="bg-[var(--bg-elevated)] w-64 max-w-[80vw] h-full overflow-y-auto p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs uppercase tracking-wider text-[var(--text-faint)]">
                  Memory
                </span>
                <button
                  type="button"
                  onClick={closeNav}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text)]"
                  aria-label="Close navigation"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ShellNav
                groups={GROUPS}
                currentSlug={currentSlug}
                hrefFor={(slug) => `/${lang}/app/${slug}`}
                onNavigate={closeNav}
                ariaLabel="Memory sections"
              />
            </aside>
          </div>
        )}

        <main className="py-6 min-w-0">
          <ProxyBaseProvider value={APP_PROXY_BASE}>{children}</ProxyBaseProvider>
        </main>
      </div>
    </div>
  )
}
