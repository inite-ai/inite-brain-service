'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import {
  CheckCircle2,
  Copy,
  CreditCard,
  Download,
  FlaskConical,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { JsonView } from './JsonView'
import { ErrorLine, Field, Modal, Segmented, inputCls } from './policies/ui'
import { getMessages, normalizeLang } from '../../lib/i18n'
import type {
  InstallPackResponse,
  PackEvalReport,
  PacksListResponse,
} from '../../lib/contracts/admin-packs'
import type {
  DisplayPrice,
  PaymentRequiredHint,
  CheckoutResponse,
} from '../../lib/contracts/admin-marketplace'

type AdminT = ReturnType<typeof getMessages>['admin']
type PacksT = AdminT['packs']

type InstallSource = 'registry' | 'manifest'

function formatPrice(price: DisplayPrice): string {
  return `${(price.amount / 100).toFixed(2)} ${price.currency}`
}

function errorMessage(json: unknown, status: number): string {
  const j = json as { message?: unknown; error?: unknown } | null
  if (typeof j?.message === 'string') return j.message
  if (typeof j?.error === 'string') return j.error
  return `Failed ${status}`
}

export function PacksPanel() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)
  const t = getMessages(lang).admin
  const p = t.packs
  const searchParams = useSearchParams()

  const [data, setData] = useState<PacksListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Install-from-registry form (prefillable via ?install=<packId> — the
  // Marketplace detail pane deep-links here).
  const [regPackId, setRegPackId] = useState(
    searchParams?.get('install') ?? '',
  )
  const [regVersion, setRegVersion] = useState('')

  // Install-by-manifest form.
  const [manifestText, setManifestText] = useState('')
  const [expectedChecksum, setExpectedChecksum] = useState('')

  const [installBusy, setInstallBusy] = useState<InstallSource | null>(null)
  const [consent, setConsent] = useState<{
    message: string
    source: InstallSource
  } | null>(null)
  const [payment, setPayment] = useState<PaymentRequiredHint | null>(null)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutOpened, setCheckoutOpened] = useState(false)
  const [success, setSuccess] = useState<InstallPackResponse | null>(null)
  const [uninstallMsg, setUninstallMsg] = useState<string | null>(null)
  const [evalFor, setEvalFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/packs', {
        cache: 'no-store',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setData(json as PacksListResponse)
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

  const doInstall = useCallback(
    async (source: InstallSource, opts?: { accept?: boolean }) => {
      setInstallBusy(source)
      setError(null)
      setSuccess(null)
      setUninstallMsg(null)
      setPayment(null)
      setCheckoutOpened(false)
      try {
        let path: string
        let body: Record<string, unknown>
        if (source === 'registry') {
          path = '/api/admin/proxy/v1/admin/packs/from-registry'
          body = {
            packId: regPackId.trim(),
            ...(regVersion.trim() ? { version: regVersion.trim() } : {}),
          }
        } else {
          let manifest: unknown
          try {
            manifest = JSON.parse(manifestText)
          } catch {
            setError(p.install.invalidJson)
            return
          }
          path = '/api/admin/proxy/v1/admin/packs'
          body = {
            manifest,
            ...(expectedChecksum.trim()
              ? { expectedChecksum: expectedChecksum.trim() }
              : {}),
          }
        }
        if (opts?.accept) body.acceptMcpTools = true
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (
          res.status === 400 &&
          typeof (json as { message?: unknown }).message === 'string' &&
          (json as { message: string }).message.includes('acceptMcpTools')
        ) {
          setConsent({
            message: (json as { message: string }).message,
            source,
          })
          return
        }
        if (res.status === 402) {
          setPayment(json as PaymentRequiredHint)
          return
        }
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        setSuccess(json as InstallPackResponse)
        await load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setInstallBusy(null)
      }
    },
    [expectedChecksum, load, manifestText, p, regPackId, regVersion],
  )

  const createCheckout = useCallback(async () => {
    if (!payment) return
    setCheckoutBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/proxy${payment.checkout.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      window.open((json as CheckoutResponse).checkoutUrl, '_blank', 'noopener')
      setCheckoutOpened(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCheckoutBusy(false)
    }
  }, [payment])

  const uninstall = useCallback(
    async (packId: string) => {
      const confirmation = window.prompt(
        p.installed.uninstallPrompt.replace('{packId}', packId),
      )
      if (confirmation === null) return
      if (confirmation !== packId) {
        setError(p.installed.confirmMismatch)
        return
      }
      setError(null)
      setUninstallMsg(null)
      try {
        const res = await fetch(
          `/api/admin/proxy/v1/admin/packs/${encodeURIComponent(packId)}`,
          { method: 'DELETE' },
        )
        const json = await res.json()
        if (!res.ok) throw new Error(errorMessage(json, res.status))
        setUninstallMsg(
          p.installed.uninstalled
            .replace('{packId}', packId)
            .replace(
              '{n}',
              String(
                (json as { predicatesDeprecated: number })
                  .predicatesDeprecated,
              ),
            ),
        )
        await load()
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [load, p],
  )

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)] flex items-center gap-2">
            <Package className="w-4 h-4 text-[var(--accent)]" /> {p.title}
          </h1>
          <p className="text-xs text-[var(--text-muted)]">{p.subtitle}</p>
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

      <ErrorLine error={error} />
      {uninstallMsg && (
        <div className="text-xs text-[var(--success)] font-mono">
          {uninstallMsg}
        </div>
      )}

      {payment && (
        <PaymentCard
          payment={payment}
          p={p}
          busy={checkoutBusy}
          opened={checkoutOpened}
          onCheckout={() => void createCheckout()}
          onRetry={() => void doInstall('registry')}
        />
      )}
      {success && <SuccessCard result={success} p={p} />}

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <article className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] space-y-2">
          <header>
            <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5 text-[var(--accent)]" />
              {p.install.fromRegistryTitle}
            </h2>
            <p className="text-[10px] text-[var(--text-muted)]">
              {p.install.fromRegistrySubtitle}
            </p>
          </header>
          <div className="grid grid-cols-[1fr_8rem] gap-2">
            <Field label={p.install.packIdLabel}>
              <input
                value={regPackId}
                onChange={(e) => setRegPackId(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </Field>
            <Field label={p.install.versionLabel} hint={p.install.versionHint}>
              <input
                value={regVersion}
                onChange={(e) => setRegVersion(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </Field>
          </div>
          <button
            type="button"
            disabled={installBusy !== null || !regPackId.trim()}
            onClick={() => void doInstall('registry')}
            className="px-3 py-1.5 rounded text-xs bg-[var(--accent)] text-white flex items-center gap-1 disabled:opacity-40"
          >
            {installBusy === 'registry' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            {installBusy === 'registry'
              ? p.install.installing
              : p.install.submit}
          </button>
        </article>

        <article className="p-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] space-y-2">
          <header>
            <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5 text-[var(--accent)]" />
              {p.install.manifestTitle}
            </h2>
            <p className="text-[10px] text-[var(--text-muted)]">
              {p.install.manifestSubtitle}
            </p>
          </header>
          <Field label={p.install.manifestLabel}>
            <textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              rows={5}
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field
            label={p.install.checksumLabel}
            hint={p.install.checksumHint}
          >
            <input
              value={expectedChecksum}
              onChange={(e) => setExpectedChecksum(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>
          <button
            type="button"
            disabled={installBusy !== null || !manifestText.trim()}
            onClick={() => void doInstall('manifest')}
            className="px-3 py-1.5 rounded text-xs bg-[var(--accent)] text-white flex items-center gap-1 disabled:opacity-40"
          >
            {installBusy === 'manifest' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Package className="w-3 h-3" />
            )}
            {installBusy === 'manifest'
              ? p.install.installing
              : p.install.submit}
          </button>
        </article>
      </section>

      <Section title={p.installed.title} subtitle={p.installed.subtitle}>
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">
                {p.installed.headers.packId}
              </th>
              <th className="text-left px-3 py-1.5">
                {p.installed.headers.version}
              </th>
              <th className="text-left px-3 py-1.5">
                {p.installed.headers.installedAt}
              </th>
              <th className="text-right px-3 py-1.5">
                {p.installed.headers.predicates}
              </th>
              <th className="text-left px-3 py-1.5">
                {p.installed.headers.checksum}
              </th>
              <th className="text-right px-3 py-1.5">
                {p.installed.headers.actions}
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.installed ?? []).map((row) => (
              <tr
                key={row.packId}
                className="border-t border-[var(--border)] font-mono"
              >
                <td className="px-3 py-1.5 text-[var(--text)]">{row.packId}</td>
                <td className="px-3 py-1.5 text-[var(--text-muted)]">
                  {row.version}
                </td>
                <td className="px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
                  {new Date(row.installedAt)
                    .toISOString()
                    .slice(0, 19)
                    .replace('T', ' ')}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.predicateCount}
                </td>
                <td
                  className="px-3 py-1.5 text-[10px] text-[var(--text-faint)]"
                  title={row.checksum ?? undefined}
                >
                  {row.checksum ? `${row.checksum.slice(0, 12)}…` : '—'}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <span className="inline-flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEvalFor(row.packId)}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--accent)]/10 text-[var(--accent)] inline-flex items-center gap-1"
                    >
                      <FlaskConical className="w-3 h-3" /> {p.installed.eval}
                    </button>
                    <button
                      type="button"
                      onClick={() => void uninstall(row.packId)}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--danger)]/10 text-[var(--danger)] inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3 h-3" /> {p.installed.uninstall}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {data && data.installed.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                >
                  {p.installed.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title={p.available.title} subtitle={p.available.subtitle}>
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-1.5">{p.available.headers.id}</th>
              <th className="text-left px-3 py-1.5">
                {p.available.headers.version}
              </th>
              <th className="text-left px-3 py-1.5">
                {p.available.headers.description}
              </th>
              <th className="text-right px-3 py-1.5">
                {p.available.headers.predicates}
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.available ?? []).map((row) => (
              <tr key={row.id} className="border-t border-[var(--border)]">
                <td className="px-3 py-1.5 font-mono text-[var(--text)]">
                  {row.id}
                  {row.builtin && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-overlay)] text-[var(--text-faint)]">
                      {p.available.builtinBadge}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-[var(--text-muted)]">
                  {row.version}
                </td>
                <td className="px-3 py-1.5 text-[var(--text-muted)]">
                  {row.description}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {row.predicateCount}
                </td>
              </tr>
            ))}
            {data && data.available.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-4 text-center text-[var(--text-muted)] italic"
                >
                  {p.available.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      {consent && (
        <Modal
          title={p.consent.title}
          onClose={() => setConsent(null)}
          wide
        >
          <p className="text-xs text-[var(--text-muted)] mb-2">
            {p.consent.note}
          </p>
          <pre className="text-[10px] font-mono text-[var(--text)] whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--bg)] p-2 max-h-60 overflow-y-auto">
            {consent.message}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConsent(null)}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
            >
              {p.consent.cancel}
            </button>
            <button
              type="button"
              onClick={() => {
                const source = consent.source
                setConsent(null)
                void doInstall(source, { accept: true })
              }}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white"
            >
              {p.consent.accept}
            </button>
          </div>
        </Modal>
      )}

      {evalFor && (
        <EvalModal packId={evalFor} p={p} onClose={() => setEvalFor(null)} />
      )}
    </div>
  )
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-[var(--text)]">{title}</h2>
        <p className="text-[11px] text-[var(--text-muted)]">{subtitle}</p>
      </div>
      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        {children}
      </div>
    </div>
  )
}

function PaymentCard({
  payment,
  p,
  busy,
  opened,
  onCheckout,
  onRetry,
}: {
  payment: PaymentRequiredHint
  p: PacksT
  busy: boolean
  opened: boolean
  onCheckout: () => void
  onRetry: () => void
}) {
  return (
    <section className="p-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 space-y-2 text-xs">
      <header className="flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-[var(--warning)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">
          {p.payment.title}
        </h2>
      </header>
      <p className="text-[var(--text-muted)]">{payment.message}</p>
      <div className="flex items-center gap-4 font-mono text-[10px]">
        <span>
          <span className="uppercase tracking-wider text-[var(--text-faint)]">
            {p.payment.packLabel}
          </span>{' '}
          <span className="text-[var(--text)]">{payment.packId}</span>
        </span>
        {payment.displayPrice && (
          <span>
            <span className="uppercase tracking-wider text-[var(--text-faint)]">
              {p.payment.priceLabel}
            </span>{' '}
            <span className="text-[var(--text)] tabular-nums">
              {formatPrice(payment.displayPrice)}
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCheckout}
          className="px-3 py-1.5 rounded text-xs bg-[var(--warning)] text-white flex items-center gap-1 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <CreditCard className="w-3 h-3" />
          )}
          {busy ? p.payment.checkoutBusy : p.payment.checkout}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 rounded text-xs border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          {p.payment.retry}
        </button>
        {opened && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {p.payment.opened} {p.payment.retryNote}
          </span>
        )}
      </div>
    </section>
  )
}

function SuccessCard({
  result,
  p,
}: {
  result: InstallPackResponse
  p: PacksT
}) {
  const [copied, setCopied] = useState(false)
  const seedTone =
    result.seedDocuments?.status === 'enqueued'
      ? 'text-[var(--success)] bg-[var(--success)]/10'
      : result.seedDocuments?.status === 'enqueue_failed'
        ? 'text-[var(--danger)] bg-[var(--danger)]/10'
        : 'text-[var(--warning)] bg-[var(--warning)]/10'
  return (
    <section className="p-3 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/5 space-y-2 text-xs">
      <header className="flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">
          {p.success.title
            .replace('{packId}', result.packId)
            .replace('{version}', result.version)}
        </h2>
      </header>
      <div className="flex items-center gap-4 flex-wrap font-mono text-[10px]">
        <span>
          <span className="uppercase tracking-wider text-[var(--text-faint)]">
            {p.success.predicatesSeeded}
          </span>{' '}
          <span className="text-[var(--text)] tabular-nums">
            {result.predicatesSeeded}
          </span>
        </span>
        <span title={result.checksum}>
          <span className="uppercase tracking-wider text-[var(--text-faint)]">
            {p.success.checksum}
          </span>{' '}
          <span className="text-[var(--text)]">
            {result.checksum.slice(0, 12)}…
          </span>
        </span>
        {result.seedDocuments && (
          <span>
            <span className="uppercase tracking-wider text-[var(--text-faint)]">
              {p.success.seedDocuments}
            </span>{' '}
            <span className="text-[var(--text)] tabular-nums">
              {result.seedDocuments.count}
            </span>{' '}
            <span className={`px-1.5 py-0.5 rounded ${seedTone}`}>
              {result.seedDocuments.status}
            </span>
          </span>
        )}
      </div>
      {result.webhookSecret && (
        <div className="p-2 rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--warning)]">
            {p.success.webhookTitle}
          </div>
          <div className="text-[10px] text-[var(--warning)]">
            {p.success.webhookNote}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[10px] text-[var(--text)] break-all">
              {result.webhookSecret}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(result.webhookSecret ?? '')
                setCopied(true)
              }}
              className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] inline-flex items-center gap-1 shrink-0"
            >
              <Copy className="w-3 h-3" />
              {copied ? `${p.success.copied} ✓` : p.success.copy}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function EvalModal({
  packId,
  p,
  onClose,
}: {
  packId: string
  p: PacksT
  onClose: () => void
}) {
  const [mode, setMode] = useState<'union' | 'dedicated'>('union')
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<PackEvalReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/packs/${encodeURIComponent(packId)}/eval?mode=${mode}`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(errorMessage(json, res.status))
      setReport(json as PackEvalReport)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal title={p.eval.title.replace('{packId}', packId)} onClose={onClose} wide>
      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-3 flex-wrap">
          <Field label={p.eval.modeLabel}>
            <Segmented
              value={mode}
              options={[
                { value: 'union' as const, label: 'union' },
                { value: 'dedicated' as const, label: 'dedicated' },
              ]}
              onChange={setMode}
            />
          </Field>
          <button
            type="button"
            disabled={running}
            onClick={() => void run()}
            className="px-3 py-1.5 rounded text-xs bg-[var(--accent)] text-white flex items-center gap-1 disabled:opacity-40 self-end"
          >
            {running ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <FlaskConical className="w-3 h-3" />
            )}
            {running ? p.eval.running : p.eval.run}
          </button>
        </div>
        <p className="text-[10px] text-[var(--text-faint)]">
          {p.eval.throttleHint}
        </p>
        <ErrorLine error={error} />
        {report && (
          <div className="space-y-2">
            <div
              className={`text-xs font-mono tabular-nums ${
                report.passed === report.total
                  ? 'text-[var(--success)]'
                  : 'text-[var(--warning)]'
              }`}
            >
              {p.eval.passedOf
                .replace('{passed}', String(report.passed))
                .replace('{total}', String(report.total))}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              {p.eval.results}
            </div>
            <div className="max-h-72 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] p-2">
              <JsonView value={report.results} initiallyOpen={2} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
