'use client'

 

import { usePathname, useParams } from 'next/navigation'
import { ReactNode, useState } from 'react'
import {
  Activity,
  CalendarClock,
  ClipboardList,
  Coins,
  Cpu,
  Database,
  FlaskConical,
  Gauge,
  Heart,
  History,
  KeyRound,
  ListChecks,
  Lock,
  Menu,
  Moon,
  Network,
  Presentation,
  Play,
  Radio,
  Settings2,
  ShieldAlert,
  Sigma,
  Skull,
  SlidersHorizontal,
  Tags,
  Trash2,
  UserRound,
  Waypoints,
  X,
} from 'lucide-react'
import { CommandPalette } from '../../../components/admin/CommandPalette'
import { Header } from '../../../components/Header'
import { ShellNav, type ShellGroup } from '../../../components/ShellNav'
import { useAuth } from '../../../hooks/useAuth'
import { normalizeLang } from '../../../lib/i18n'

interface Props {
  children: ReactNode
}

const GROUPS: ShellGroup[] = [
  {
    label: 'Ops',
    items: [
      { slug: 'explore/overview', title: 'Overview', icon: Activity },
      { slug: 'maintenance', title: 'Maintenance', icon: CalendarClock },
      { slug: 'jobs', title: 'Jobs', icon: Play },
      { slug: 'dreams', title: 'Dreams', icon: Moon },
      { slug: 'cost', title: 'Cost', icon: Coins },
      { slug: 'audit', title: 'Audit log', icon: History },
      { slug: 'operator-actions', title: 'Operator actions', icon: KeyRound },
      { slug: 'router', title: 'Router / cache', icon: Gauge },
      { slug: 'predicates', title: 'Predicates', icon: Tags },
    ],
  },
  {
    label: 'Compliance',
    items: [
      { slug: 'pii', title: 'PII inventory', icon: ShieldAlert },
      { slug: 'forgotten', title: 'Forgotten', icon: Skull },
      { slug: 'dlq', title: 'Dead-letter', icon: Trash2 },
      { slug: 'config', title: 'Config', icon: Settings2 },
    ],
  },
  {
    label: 'Infra',
    items: [
      { slug: 'health', title: 'Health', icon: Heart },
      { slug: 'migrations', title: 'Migrations', icon: Database },
      { slug: 'throttler', title: 'Throttler', icon: SlidersHorizontal },
      { slug: 'now', title: 'In-flight', icon: Radio },
      { slug: 'leases', title: 'Leases', icon: Lock },
    ],
  },
  {
    label: 'Eval',
    items: [
      { slug: 'scenarios', title: 'Scenarios', icon: ListChecks },
      { slug: 'baselines', title: 'Baselines', icon: ClipboardList },
      { slug: 'calibration', title: 'Calibration', icon: Sigma },
      { slug: 'traces', title: 'Traces', icon: Waypoints },
    ],
  },
  {
    label: 'Dev',
    items: [
      { slug: 'playground', title: 'Playground', icon: FlaskConical },
      { slug: 'explore/graph', title: 'Graph explorer', icon: Network },
      { slug: 'reindex', title: 'Reindex', icon: Cpu },
    ],
  },
  {
    label: 'Live',
    items: [{ slug: 'demo', title: 'Demo deck', icon: Presentation }],
  },
]

export default function AdminLayout({ children }: Props) {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const pathname = usePathname() ?? ''
  const auth = useAuth()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

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

  const closeNav = () => setMobileNavOpen(false)

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <Header lang={lang} context="Admin" />

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
          <CommandPalette lang={lang} />
          <div className="ml-auto flex items-center gap-2 text-[var(--text-muted)]">
            {auth.email && (
              <span className="hidden sm:flex items-center gap-1">
                <UserRound className="w-3 h-3 text-[var(--text-faint)]" />
                <span className="font-mono">{auth.email}</span>
              </span>
            )}
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                auth.isAdmin
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'bg-[var(--bg-overlay)] text-[var(--text-faint)]'
              }`}
            >
              {auth.loading ? '…' : auth.isAdmin ? 'brain:admin' : 'no admin'}
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 md:grid md:grid-cols-[14rem_1fr] md:gap-6">
        <aside className="hidden md:block sticky top-[5.5rem] self-start py-6 max-h-[calc(100vh-5.5rem)] overflow-y-auto">
          <ShellNav
            groups={GROUPS}
            currentSlug={currentSlug}
            hrefFor={(slug) => `/${lang}/admin/${slug}`}
            onNavigate={closeNav}
            ariaLabel="Admin sections"
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
                  Admin
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
                hrefFor={(slug) => `/${lang}/admin/${slug}`}
                onNavigate={closeNav}
                ariaLabel="Admin sections"
              />
            </aside>
          </div>
        )}

        <main className="py-6 min-w-0">{children}</main>
      </div>
    </div>
  )
}
