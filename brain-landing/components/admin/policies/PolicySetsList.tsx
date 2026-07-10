'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  KeyRound,
  Plus,
  RefreshCw,
  ScanEye,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type {
  PolicySet,
  PolicySetsListResponse,
} from '../../../lib/contracts/admin-policies'
import { ModeBadge, PostureChip } from './PolicyBadges'
import { ErrorLine, SkeletonCard } from './ui'

interface Template {
  id: string
  title: string
  blurb: string
  document: Record<string, unknown>
}

const TEMPLATES: Template[] = [
  {
    id: 'readonly-agent',
    title: 'readonly-agent',
    blurb: 'Default-deny. The key can call every read tool and nothing else — the baseline for any agent with web access.',
    document: {
      name: 'readonly-agent',
      description: 'Read-only agent: default-deny actions, all reads allowed',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'report_only',
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', enabled: true, actions: ['@readonly'] },
      ],
    },
  },
  {
    id: 'support-only-reader',
    title: 'support-only-reader',
    blurb: 'Default-deny on both domains: read tools only, and only facts that arrived through the support vertical.',
    document: {
      name: 'support-only-reader',
      description: 'Read-only + support-vertical facts only',
      posture: { actions: 'deny', reads: 'deny' },
      mode: 'report_only',
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', enabled: true, actions: ['@readonly'] },
        {
          id: 'support-open',
          effect: 'allow',
          kind: 'source',
          enabled: true,
          match: [{ attr: 'source.vertical', op: 'eq', value: 'support' }],
        },
      ],
    },
  },
  {
    id: 'no-pii-analytics',
    title: 'no-pii-analytics',
    blurb: 'Default-allow, minus PII: hides identifier/sensitive predicates and pii-classed documents, denies destructive tools.',
    document: {
      name: 'no-pii-analytics',
      description: 'Analytics key: everything except PII and destructive writes',
      posture: { actions: 'allow', reads: 'allow' },
      mode: 'report_only',
      rules: [
        {
          id: 'no-pii-class',
          effect: 'deny',
          kind: 'source',
          enabled: true,
          match: [{ attr: 'piiClass', op: 'in', value: ['identifier', 'sensitive'] }],
        },
        {
          id: 'no-pii-meta',
          effect: 'deny',
          kind: 'source',
          enabled: true,
          match: [{ attr: 'source.meta.data_class', op: 'in', value: ['pii', 'sensitive'] }],
        },
        {
          id: 'no-destructive',
          effect: 'deny',
          kind: 'action',
          enabled: true,
          actions: ['forget_entity', 'retract_fact', 'rest.users.forget'],
        },
      ],
    },
  },
]

export function PolicySetsList() {
  const router = useRouter()
  const params = useParams<{ lang: string }>()
  const lang = params?.lang ?? 'en'
  const [items, setItems] = useState<PolicySet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/policy-sets', {
        cache: 'no-store',
      })
      const data = (await res.json()) as PolicySetsListResponse | { error?: string }
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Failed ${res.status}`)
      setItems((data as PolicySetsListResponse).policySets ?? [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const createFromTemplate = useCallback(
    async (t: Template) => {
      setBusy(t.id)
      try {
        const res = await fetch('/api/admin/proxy/v1/admin/policy-sets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(t.document),
        })
        const data = await res.json()
        if (!res.ok) {
          throw new Error(
            data.error === 'invalid_policy_document'
              ? JSON.stringify(data.issues)
              : (data.message?.message ?? data.error ?? `Failed ${res.status}`),
          )
        }
        router.push(`/${lang}/admin/policies/${encodeURIComponent(t.document.name as string)}`)
      } catch (e) {
        setError((e as Error).message)
        setBusy(null)
      }
    },
    [lang, router],
  )

  const remove = useCallback(
    async (name: string) => {
      if (!window.confirm(`Delete policy set '${name}'?`)) return
      setBusy(name)
      try {
        const res = await fetch(
          `/api/admin/proxy/v1/admin/policy-sets/${encodeURIComponent(name)}`,
          { method: 'DELETE' },
        )
        const data = await res.json()
        if (!res.ok) {
          throw new Error(data.message?.message ?? data.error ?? `Failed ${res.status}`)
        }
        await load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  if (loading) {
    return (
      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <ShieldCheck className="mx-auto h-10 w-10 text-[var(--accent)]" />
        <h1 className="mt-4 text-lg font-semibold text-[var(--text)]">
          Policy sets
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--text-muted)]">
          Policy sets gate which tools an API key can call and which facts it
          can read — by predicate, source vertical, document metadata, or
          trust thresholds. Attach them to keys and start in report-only:
          nothing is blocked until you promote to enforce.
        </p>
        <ErrorLine error={error} />
        <div className="mt-8 grid gap-4 text-left sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={busy !== null}
              onClick={() => void createFromTemplate(t)}
              className="group rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-left transition-colors hover:border-[var(--accent)]"
            >
              <div className="flex items-center gap-2">
                <Plus className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span className="font-mono text-xs font-medium text-[var(--text)]">
                  {t.title}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {t.blurb}
              </p>
              <span className="mt-3 inline-block text-[10px] uppercase tracking-wider text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100">
                {busy === t.id ? 'creating…' : 'create draft →'}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">Policy sets</h1>
          <p className="text-xs text-[var(--text-muted)]">
            {items.length} set{items.length === 1 ? '' : 's'} · deny overrides
            allow · unmatched falls to the default posture
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-[var(--border)] p-1.5 text-[var(--text-muted)] hover:text-[var(--text)]"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <div className="relative">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover,var(--accent))]">
                <Plus className="h-3.5 w-3.5" /> New from template
              </summary>
              <div className="absolute right-0 z-10 mt-1 w-72 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-2 shadow-xl">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void createFromTemplate(t)}
                    className="block w-full rounded p-2 text-left hover:bg-[var(--bg-overlay)]"
                  >
                    <span className="font-mono text-xs text-[var(--text)]">{t.title}</span>
                    <span className="mt-0.5 block text-[10px] text-[var(--text-muted)]">
                      {t.blurb}
                    </span>
                  </button>
                ))}
              </div>
            </details>
          </div>
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="mt-2 grid gap-4 lg:grid-cols-2">
        {items.map((s) => {
          const allow = s.rules.filter((r) => r.effect === 'allow').length
          const deny = s.rules.filter((r) => r.effect === 'deny').length
          return (
            <div
              key={s.name}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-[var(--text)]">
                      {s.name}
                    </span>
                    <ModeBadge mode={s.mode} />
                  </div>
                  {s.description ? (
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{s.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void remove(s.name)}
                  disabled={busy === s.name || s.attachedSubjects.length > 0}
                  title={
                    s.attachedSubjects.length > 0
                      ? 'Detach keys before deleting'
                      : 'Delete'
                  }
                  className="text-[var(--text-faint)] hover:text-[var(--danger)] disabled:opacity-30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)]">
                <span>
                  <span className="text-[var(--success)]">{allow} allow</span>
                  {' · '}
                  <span className="text-[var(--danger)]">{deny} deny</span>
                  {' rules'}
                </span>
                <PostureChip domain="actions" posture={s.posture.actions} />
                <PostureChip domain="reads" posture={s.posture.reads} />
                <span className="inline-flex items-center gap-1">
                  <KeyRound className="h-3 w-3" />
                  {s.attachedSubjects.length}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-3">
                <span className="text-[10px] font-mono text-[var(--text-faint)]">
                  v{s.version} · {new Date(s.updatedAt).toLocaleString()} · {s.updatedBy}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      router.push(
                        `/${lang}/admin/key-lens?policySet=${encodeURIComponent(s.name)}`,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
                  >
                    <ScanEye className="h-3 w-3" /> Simulate
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      router.push(`/${lang}/admin/policies/${encodeURIComponent(s.name)}`)
                    }
                    className="rounded bg-[var(--accent)]/15 px-2 py-1 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/25"
                  >
                    Edit
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
