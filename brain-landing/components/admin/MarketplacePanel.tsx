'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  BadgeCheck,
  Download,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Star,
  Store,
} from 'lucide-react'
import { ErrorLine, Drawer, Field, Modal, inputCls } from './policies/ui'
import { getMessages, normalizeLang } from '../../lib/i18n'
import type {
  DisplayPrice,
  PublisherResponse,
  RegistryPackSummary,
  RegistryVersion,
  RegistryVersionsResponse,
} from '../../lib/contracts/admin-marketplace'

type AdminT = ReturnType<typeof getMessages>['admin']
type MarketT = AdminT['marketplace']

type RegistryScope = 'registry:curate' | 'registry:publish'

function formatPrice(price: DisplayPrice): string {
  return `${(price.amount / 100).toFixed(2)} ${price.currency}`
}

function errorMessage(json: unknown, status: number): string {
  const j = json as { message?: unknown; error?: unknown } | null
  if (typeof j?.message === 'string') return j.message
  if (typeof j?.error === 'string') return j.error
  return `Failed ${status}`
}

export function MarketplacePanel() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const t = getMessages(lang).admin
  const m = t.marketplace

  const [packs, setPacks] = useState<RegistryPackSummary[]>([])
  const [filter, setFilter] = useState({ q: '', publisher: '', tag: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<RegistryVersionsResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [missingScopes, setMissingScopes] = useState<RegistryScope[]>([])
  const [pricingFor, setPricingFor] = useState<string | null>(null)
  const [publisherOpen, setPublisherOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qp = new URLSearchParams()
      if (filter.q) qp.set('q', filter.q)
      if (filter.publisher) qp.set('publisher', filter.publisher)
      if (filter.tag) qp.set('tag', filter.tag)
      qp.set('limit', '100')
      const res = await fetch(
        `/api/admin/proxy/v1/registry/packs?${qp.toString()}`,
        { cache: 'no-store' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setPacks((json as { packs: RegistryPackSummary[] }).packs ?? [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void load()
  }, [load])

  const loadDetail = useCallback(async (packId: string) => {
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/registry/packs/${encodeURIComponent(packId)}`,
        { cache: 'no-store' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setDetail(json as RegistryVersionsResponse)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const select = useCallback(
    (packId: string) => {
      setSelected(packId)
      setDetail(null)
      void loadDetail(packId)
    },
    [loadDetail],
  )

  const noteMissing = useCallback((scope: RegistryScope) => {
    setMissingScopes((prev) =>
      prev.includes(scope) ? prev : [...prev, scope],
    )
  }, [])

  /** Shared write path: 403 → scope-degradation note, not a red error. */
  const write = useCallback(
    async (opts: {
      key: string
      method: 'POST' | 'PUT' | 'DELETE'
      path: string
      body?: unknown
      scope: RegistryScope
    }): Promise<boolean> => {
      setBusy(opts.key)
      setError(null)
      try {
        const res = await fetch(`/api/admin/proxy/${opts.path}`, {
          method: opts.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts.body ?? {}),
        })
        if (res.status === 403) {
          noteMissing(opts.scope)
          return false
        }
        const json = await res.json().catch(() => null)
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        return true
      } catch (e) {
        setError((e as Error).message)
        return false
      } finally {
        setBusy(null)
      }
    },
    [noteMissing],
  )

  const selectedSummary = useMemo(
    () => packs.find((p) => p.packId === selected) ?? null,
    [packs, selected],
  )

  const toggleFeature = useCallback(
    async (pack: RegistryPackSummary) => {
      const action = pack.featured ? 'unfeature' : 'feature'
      const ok = await write({
        key: action,
        method: 'POST',
        path: `v1/admin/registry/packs/${encodeURIComponent(pack.packId)}/${action}`,
        scope: 'registry:curate',
      })
      if (ok) await load()
    },
    [load, write],
  )

  const clearPricing = useCallback(
    async (packId: string) => {
      const ok = await write({
        key: 'clear-pricing',
        method: 'DELETE',
        path: `v1/admin/registry/packs/${encodeURIComponent(packId)}/pricing`,
        scope: 'registry:publish',
      })
      if (ok) await load()
    },
    [load, write],
  )

  const yank = useCallback(
    async (v: RegistryVersion, direction: 'yank' | 'unyank') => {
      if (direction === 'yank') {
        const confirmation = window.prompt(
          m.detail.yankPrompt
            .replace('{packId}', v.packId)
            .replace('{version}', v.version),
        )
        if (confirmation === null) return
        if (confirmation !== v.version) {
          setError(m.detail.confirmMismatch)
          return
        }
      }
      const reason =
        direction === 'yank'
          ? (window.prompt(m.detail.yankReasonPrompt) ?? '').trim()
          : ''
      const ok = await write({
        key: `${direction}-${v.version}`,
        method: 'POST',
        path: `v1/admin/registry/packs/${encodeURIComponent(v.packId)}/${encodeURIComponent(v.version)}/${direction}`,
        body: reason ? { reason } : {},
        scope: 'registry:publish',
      })
      if (ok) {
        await Promise.all([load(), loadDetail(v.packId)])
      }
    },
    [load, loadDetail, m, write],
  )

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Store className="w-4 h-4 text-[var(--accent)]" /> {m.title}
          </h1>
          <p className="text-xs text-[var(--text-muted)]">{m.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {t.common.refresh}
        </button>
      </header>

      <div className="flex gap-2 items-center flex-wrap text-xs">
        <input
          placeholder={m.filters.qPlaceholder}
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] w-52"
        />
        <input
          placeholder={m.filters.publisherPlaceholder}
          value={filter.publisher}
          onChange={(e) =>
            setFilter((f) => ({ ...f, publisher: e.target.value }))
          }
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono w-40"
        />
        <input
          placeholder={m.filters.tagPlaceholder}
          value={filter.tag}
          onChange={(e) => setFilter((f) => ({ ...f, tag: e.target.value }))}
          className="border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)] font-mono w-32"
        />
      </div>

      <ErrorLine error={error} />
      {missingScopes.map((scope) => (
        <ScopeNote key={scope} scope={scope} m={m} />
      ))}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_24rem] gap-3">
        <div className="rounded-md border border-[var(--border)] overflow-hidden self-start">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2">{m.table.headers.pack}</th>
                <th className="text-left px-3 py-2">
                  {m.table.headers.version}
                </th>
                <th className="text-left px-3 py-2">
                  {m.table.headers.publisher}
                </th>
                <th className="text-left px-3 py-2">
                  {m.table.headers.badges}
                </th>
                <th className="text-right px-3 py-2">
                  {m.table.headers.downloads}
                </th>
                <th className="text-right px-3 py-2">
                  {m.table.headers.published}
                </th>
              </tr>
            </thead>
            <tbody>
              {packs.map((pack) => (
                <tr
                  key={pack.packId}
                  onClick={() => select(pack.packId)}
                  className={`border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40 cursor-pointer ${
                    selected === pack.packId ? 'bg-[var(--bg-overlay)]/60' : ''
                  }`}
                >
                  <td className="px-3 py-1.5 font-mono text-[var(--text)]">
                    {pack.packId}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                    {pack.latestVersion}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px]">
                    {pack.publisher ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPublisherOpen(pack.publisher)
                        }}
                        className="text-[var(--accent)] hover:underline"
                      >
                        {pack.publisher}
                      </button>
                    ) : (
                      <span className="text-[var(--text-faint)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <PackBadges pack={pack} m={m} />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums">
                    {pack.downloads}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] text-[var(--text-muted)]">
                    {pack.publishedAt ? pack.publishedAt.slice(0, 10) : '—'}
                  </td>
                </tr>
              ))}
              {packs.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                  >
                    {m.table.empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <aside className="border border-[var(--border)] rounded-md p-3 bg-[var(--bg-elevated)] max-h-[75vh] overflow-y-auto">
          {selectedSummary ? (
            <PackDetail
              pack={selectedSummary}
              detail={detail}
              m={m}
              lang={lang}
              busy={busy}
              onToggleFeature={() => void toggleFeature(selectedSummary)}
              onSetPricing={() => setPricingFor(selectedSummary.packId)}
              onClearPricing={() => void clearPricing(selectedSummary.packId)}
              onYank={(v, dir) => void yank(v, dir)}
            />
          ) : (
            <div className="text-xs text-[var(--text-muted)] italic">
              {m.detail.prompt}
            </div>
          )}
        </aside>
      </div>

      {pricingFor && (
        <PricingModal
          packId={pricingFor}
          m={m}
          onClose={() => setPricingFor(null)}
          onSave={async (body) => {
            const ok = await write({
              key: 'set-pricing',
              method: 'PUT',
              path: `v1/admin/registry/packs/${encodeURIComponent(pricingFor)}/pricing`,
              body,
              scope: 'registry:publish',
            })
            if (ok) await load()
            setPricingFor(null)
          }}
        />
      )}

      {publisherOpen && (
        <PublisherDrawer
          publisher={publisherOpen}
          m={m}
          onClose={() => setPublisherOpen(null)}
          onSelectPack={(packId) => {
            setPublisherOpen(null)
            select(packId)
          }}
          onMissingScope={noteMissing}
        />
      )}
    </div>
  )
}

function ScopeNote({ scope, m }: { scope: RegistryScope; m: MarketT }) {
  return (
    <div className="flex items-start gap-2 rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-[11px] text-[var(--warning)]">
      <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{m.scopeNote.replace('{scope}', scope)}</span>
    </div>
  )
}

function PackBadges({
  pack,
  m,
}: {
  pack: RegistryPackSummary
  m: MarketT
}) {
  const badge = 'px-1.5 py-0.5 rounded text-[10px] font-mono'
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {pack.verified && (
        <span className={`${badge} text-[var(--success)] bg-[var(--success)]/10`}>
          {m.badges.verified}
        </span>
      )}
      {pack.signed && (
        <span className={`${badge} text-[var(--text-muted)] bg-[var(--bg-overlay)]`}>
          {m.badges.signed}
        </span>
      )}
      {pack.featured && (
        <span className={`${badge} text-[var(--accent)] bg-[var(--accent)]/10`}>
          {m.badges.featured}
        </span>
      )}
      {pack.paid && (
        <span className={`${badge} text-[var(--warning)] bg-[var(--warning)]/10`}>
          {pack.displayPrice
            ? `${m.badges.paid} · ${formatPrice(pack.displayPrice)}`
            : m.badges.paid}
        </span>
      )}
      {pack.origin && (
        <span
          className={`${badge} text-[var(--text-faint)] bg-[var(--bg-overlay)]`}
          title={m.detail.originLabel.concat(': ', pack.origin)}
        >
          {m.badges.mirror}
        </span>
      )}
    </span>
  )
}

function PackDetail({
  pack,
  detail,
  m,
  lang,
  busy,
  onToggleFeature,
  onSetPricing,
  onClearPricing,
  onYank,
}: {
  pack: RegistryPackSummary
  detail: RegistryVersionsResponse | null
  m: MarketT
  lang: string
  busy: string | null
  onToggleFeature: () => void
  onSetPricing: () => void
  onClearPricing: () => void
  onYank: (v: RegistryVersion, direction: 'yank' | 'unyank') => void
}) {
  const d = m.detail
  return (
    <div className="space-y-3 text-xs">
      <header className="flex items-baseline gap-2 flex-wrap">
        <div className="font-mono text-[var(--text)]">{pack.packId}</div>
        <PackBadges pack={pack} m={m} />
      </header>
      <p className="text-[var(--text-muted)]">{pack.description}</p>
      {pack.keywords.length > 0 && (
        <div className="text-[10px] font-mono text-[var(--text-faint)]">
          {pack.keywords.join(' · ')}
        </div>
      )}
      {pack.origin && (
        <div className="text-[10px] font-mono text-[var(--text-faint)]">
          {d.originLabel}: {pack.origin}
        </div>
      )}

      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          disabled={busy !== null}
          onClick={onToggleFeature}
          className="px-2 py-1 rounded text-[10px] bg-[var(--accent)]/10 text-[var(--accent)] inline-flex items-center gap-1 disabled:opacity-40"
        >
          {busy === 'feature' || busy === 'unfeature' ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Star className="w-3 h-3" />
          )}
          {pack.featured ? d.unfeature : d.feature}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={onSetPricing}
          className="px-2 py-1 rounded text-[10px] bg-[var(--bg-overlay)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40"
        >
          {d.setPricing}
        </button>
        {pack.paid && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={onClearPricing}
            className="px-2 py-1 rounded text-[10px] bg-[var(--bg-overlay)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40"
          >
            {busy === 'clear-pricing' ? (
              <Loader2 className="w-3 h-3 animate-spin inline" />
            ) : (
              d.clearPricing
            )}
          </button>
        )}
        <Link
          href={`/${lang}/admin/packs?install=${encodeURIComponent(pack.packId)}`}
          className="px-2 py-1 rounded text-[10px] bg-[var(--success)]/10 text-[var(--success)] inline-flex items-center gap-1"
        >
          <Download className="w-3 h-3" /> {d.installLink} →
        </Link>
      </div>

      <section>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
          {d.versions}
        </div>
        {detail ? (
          <table className="w-full text-[10px]">
            <thead className="text-[var(--text-faint)] uppercase tracking-wider">
              <tr>
                <th className="text-left px-1 py-1">
                  {d.versionHeaders.version}
                </th>
                <th className="text-left px-1 py-1">
                  {d.versionHeaders.published}
                </th>
                <th className="text-right px-1 py-1">
                  {d.versionHeaders.downloads}
                </th>
                <th className="text-left px-1 py-1">
                  {d.versionHeaders.status}
                </th>
                <th className="text-right px-1 py-1">
                  {d.versionHeaders.actions}
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map((v) => (
                <tr
                  key={v.version}
                  className="border-t border-[var(--border)] font-mono"
                >
                  <td className="px-1 py-1 text-[var(--text)]">{v.version}</td>
                  <td className="px-1 py-1 text-[var(--text-muted)]">
                    {v.publishedAt.slice(0, 10)}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">
                    {v.downloads}
                  </td>
                  <td className="px-1 py-1">
                    {v.yanked ? (
                      <span
                        className="px-1 py-0.5 rounded text-[var(--danger)] bg-[var(--danger)]/10"
                        title={v.yankReason ?? undefined}
                      >
                        {m.badges.yanked}
                      </span>
                    ) : (
                      <span className="px-1 py-0.5 rounded text-[var(--success)] bg-[var(--success)]/10">
                        {d.ok}
                      </span>
                    )}
                  </td>
                  <td className="px-1 py-1 text-right">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => onYank(v, v.yanked ? 'unyank' : 'yank')}
                      className={`px-1.5 py-0.5 rounded disabled:opacity-40 ${
                        v.yanked
                          ? 'text-[var(--success)] bg-[var(--success)]/10'
                          : 'text-[var(--danger)] bg-[var(--danger)]/10'
                      }`}
                    >
                      {v.yanked ? d.unyank : d.yank}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-[10px] text-[var(--text-muted)] italic">
            {'…'}
          </div>
        )}
      </section>
    </div>
  )
}

function PricingModal({
  packId,
  m,
  onClose,
  onSave,
}: {
  packId: string
  m: MarketT
  onClose: () => void
  onSave: (body: { amount: number; currency: string }) => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const submit = async () => {
    const parsed = Number(amount)
    if (
      !Number.isInteger(parsed) ||
      parsed <= 0 ||
      !/^[A-Za-z]{3}$/.test(currency)
    ) {
      setLocalError(m.pricing.invalid)
      return
    }
    setSaving(true)
    try {
      await onSave({ amount: parsed, currency: currency.toUpperCase() })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={m.pricing.title.replace('{packId}', packId)} onClose={onClose}>
      <div className="space-y-3">
        <Field label={m.pricing.amountLabel} hint={m.pricing.amountHint}>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            type="number"
            min={1}
            step={1}
            className={`${inputCls} font-mono`}
          />
        </Field>
        <Field label={m.pricing.currencyLabel} hint={m.pricing.currencyHint}>
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={3}
            className={`${inputCls} font-mono w-24`}
          />
        </Field>
        <ErrorLine error={localError} />
        <div className="flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {saving ? m.pricing.saving : m.pricing.save}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function PublisherDrawer({
  publisher,
  m,
  onClose,
  onSelectPack,
  onMissingScope,
}: {
  publisher: string
  m: MarketT
  onClose: () => void
  onSelectPack: (packId: string) => void
  onMissingScope: (scope: RegistryScope) => void
}) {
  const [data, setData] = useState<PublisherResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scopeMissing, setScopeMissing] = useState(false)
  const [form, setForm] = useState({
    displayName: '',
    url: '',
    bio: '',
    contactEmail: '',
  })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/registry/publishers/${encodeURIComponent(publisher)}`,
        { cache: 'no-store' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      const resp = json as PublisherResponse
      setData(resp)
      setForm({
        displayName: resp.profile?.displayName ?? '',
        url: resp.profile?.url ?? '',
        bio: resp.profile?.bio ?? '',
        contactEmail: resp.profile?.contactEmail ?? '',
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }, [publisher])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/registry/publishers/${encodeURIComponent(publisher)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: form.displayName,
            ...(form.url.trim() ? { url: form.url.trim() } : {}),
            ...(form.bio.trim() ? { bio: form.bio.trim() } : {}),
            ...(form.contactEmail.trim()
              ? { contactEmail: form.contactEmail.trim() }
              : {}),
          }),
        },
      )
      if (res.status === 403) {
        setScopeMissing(true)
        onMissingScope('registry:publish')
        return
      }
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      title={m.publisher.title.replace('{publisher}', publisher)}
      onClose={onClose}
    >
      <div className="space-y-4 text-xs">
        <ErrorLine error={error} />
        {scopeMissing && (
          <ScopeNote scope={'registry:publish'} m={m} />
        )}
        {data && !data.profile && (
          <p className="text-[var(--text-muted)] italic">
            {m.publisher.noProfile}
          </p>
        )}
        {data?.profile && (
          <div className="grid grid-cols-2 gap-1 text-[10px] font-mono text-[var(--text-muted)]">
            <span className="uppercase tracking-wider text-[var(--text-faint)]">
              {m.publisher.createdLabel}
            </span>
            <span>{data.profile.createdAt.slice(0, 10)}</span>
            <span className="uppercase tracking-wider text-[var(--text-faint)]">
              {m.publisher.updatedLabel}
            </span>
            <span>
              {data.profile.updatedAt ? data.profile.updatedAt.slice(0, 10) : '—'}
            </span>
          </div>
        )}
        <div className="space-y-2">
          <Field label={m.publisher.displayNameLabel}>
            <input
              value={form.displayName}
              onChange={(e) =>
                setForm((f) => ({ ...f, displayName: e.target.value }))
              }
              maxLength={120}
              className={inputCls}
            />
          </Field>
          <Field label={m.publisher.urlLabel}>
            <input
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label={m.publisher.bioLabel}>
            <textarea
              value={form.bio}
              onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
              maxLength={2000}
              rows={3}
              className={inputCls}
            />
          </Field>
          <Field label={m.publisher.contactEmailLabel}>
            <input
              value={form.contactEmail}
              onChange={(e) =>
                setForm((f) => ({ ...f, contactEmail: e.target.value }))
              }
              className={`${inputCls} font-mono`}
            />
          </Field>
          <button
            type="button"
            disabled={saving || !form.displayName.trim()}
            onClick={() => void save()}
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {saving ? m.publisher.saving : m.publisher.save}
          </button>
        </div>
        {data && data.packs.length > 0 && (
          <section>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1 flex items-center gap-1">
              <BadgeCheck className="w-3 h-3" /> {m.publisher.packsTitle}
            </div>
            <ul className="space-y-1">
              {data.packs.map((pack) => (
                <li key={pack.packId}>
                  <button
                    type="button"
                    onClick={() => onSelectPack(pack.packId)}
                    className="font-mono text-[10px] text-[var(--accent)] hover:underline"
                  >
                    {pack.packId}
                  </button>
                  <span className="ml-1 font-mono text-[10px] text-[var(--text-faint)]">
                    {pack.latestVersion}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  )
}
