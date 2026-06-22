'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: pre-Phase-J component, queued for separate pass. New code MUST go through getMessages(lang). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Edit3,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react'

type Semantics = 'append_only' | 'single_active' | 'bitemporal'
type PiiClass =
  | 'none'
  | 'identifier'
  | 'behavioral'
  | 'text'
  | 'sensitive'
type PredicateStatus = 'active' | 'proposed' | 'aliased' | 'deprecated'

interface Predicate {
  predicateId: string
  displayLabel: string
  description: string
  datatype: 'string' | 'number' | 'date' | 'datetime' | 'enum' | 'json'
  semantics: Semantics
  decayHalfLifeDays: number | null
  piiClass: PiiClass
  requiresScope?: string
  parentPredicateId?: string
  subjectClasses?: string[]
  allowedValues?: string[]
  status: PredicateStatus
  aliasedTo?: string
  createdBy: 'system' | 'admin' | 'llm_auto' | 'migration'
}

interface ListResponse {
  predicates: Predicate[]
  error?: string
}

type Filter = 'all' | PredicateStatus

const STATUS_TONE: Record<PredicateStatus, string> = {
  active: 'text-[var(--success)] bg-[var(--success)]/10',
  proposed: 'text-[var(--warning)] bg-[var(--warning)]/10',
  aliased: 'text-[var(--text-muted)] bg-[var(--bg-overlay)]',
  deprecated: 'text-[var(--text-faint)] bg-[var(--bg-overlay)]',
}

const PII_TONE: Record<PiiClass, string> = {
  none: 'text-[var(--text-faint)]',
  identifier: 'text-[var(--accent)]',
  behavioral: 'text-[var(--text-muted)]',
  text: 'text-[var(--text-muted)]',
  sensitive: 'text-[var(--danger)]',
}

export function PredicateRegistry() {
  const [items, setItems] = useState<Predicate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<Predicate | null>(null)
  const [creating, setCreating] = useState(false)
  const [aliasing, setAliasing] = useState<Predicate | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/proxy/v1/admin/predicates', {
        cache: 'no-store',
      })
      const data = (await res.json()) as ListResponse
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      setItems(data.predicates ?? [])
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

  const filtered = useMemo(() => {
    return items.filter((p) => {
      if (filter !== 'all' && p.status !== filter) return false
      if (!q.trim()) return true
      const needle = q.toLowerCase()
      return (
        p.predicateId.toLowerCase().includes(needle) ||
        p.displayLabel.toLowerCase().includes(needle) ||
        p.description.toLowerCase().includes(needle)
      )
    })
  }, [items, q, filter])

  const counts = useMemo(() => {
    const c: Record<PredicateStatus | 'all', number> = {
      all: items.length,
      active: 0,
      proposed: 0,
      aliased: 0,
      deprecated: 0,
    }
    for (const p of items) c[p.status] = (c[p.status] ?? 0) + 1
    return c
  }, [items])

  const promote = useCallback(
    async (p: Predicate) => {
      setBusyId(p.predicateId)
      try {
        const res = await fetch(
          `/api/admin/proxy/v1/admin/predicates/${encodeURIComponent(p.predicateId)}/promote`,
          { method: 'POST' },
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
        await load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  const deprecate = useCallback(
    async (p: Predicate) => {
      if (
        !confirm(
          `Deprecate predicate "${p.predicateId}"? Existing facts keep working but the extractor will stop emitting it.`,
        )
      ) {
        return
      }
      setBusyId(p.predicateId)
      try {
        const res = await fetch(
          `/api/admin/proxy/v1/admin/predicates/${encodeURIComponent(p.predicateId)}`,
          { method: 'DELETE' },
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
        await load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">
            Predicate registry
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Per-tenant predicate ontology. EDC auto-aliases novel predicates;
            operators promote/alias/deprecate here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            refresh
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="px-2.5 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs flex items-center gap-1.5"
          >
            <Plus className="w-3 h-3" /> New predicate
          </button>
        </div>
      </header>

      <div className="flex gap-2 items-center text-xs">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter id / label / description"
          className="flex-1 max-w-sm border border-[var(--border)] rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
        />
        <div className="flex border border-[var(--border)] rounded-md overflow-hidden text-[10px]">
          {(['all', 'active', 'proposed', 'aliased', 'deprecated'] as const).map(
            (f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2 py-1 border-r border-[var(--border)] last:border-r-0 ${
                  filter === f
                    ? 'bg-[var(--bg-overlay)] text-[var(--text)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {f} <span className="text-[var(--text-faint)]">({counts[f]})</span>
              </button>
            ),
          )}
        </div>
      </div>

      {error && (
        <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
      )}

      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--bg-overlay)] text-[var(--text-faint)] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-2 font-medium">predicate</th>
              <th className="text-left px-3 py-2 font-medium">semantics</th>
              <th className="text-left px-3 py-2 font-medium">datatype</th>
              <th className="text-left px-3 py-2 font-medium">pii</th>
              <th className="text-left px-3 py-2 font-medium">status</th>
              <th className="text-left px-3 py-2 font-medium">decay</th>
              <th className="text-left px-3 py-2 font-medium">created</th>
              <th className="text-right px-3 py-2 font-medium">actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <PredicateRow
                key={p.predicateId}
                p={p}
                busy={busyId === p.predicateId}
                onEdit={() => setEditing(p)}
                onPromote={() => void promote(p)}
                onDeprecate={() => void deprecate(p)}
                onAlias={() => setAliasing(p)}
              />
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-[var(--text-muted)] italic"
                >
                  No predicates match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <PredicateEditor
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            void load()
          }}
        />
      )}
      {editing && (
        <PredicateEditor
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
      {aliasing && (
        <AliasModal
          predicate={aliasing}
          candidates={items.filter(
            (i) =>
              i.status === 'active' && i.predicateId !== aliasing.predicateId,
          )}
          onClose={() => setAliasing(null)}
          onSaved={() => {
            setAliasing(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

function PredicateRow({
  p,
  busy,
  onEdit,
  onPromote,
  onDeprecate,
  onAlias,
}: {
  p: Predicate
  busy: boolean
  onEdit: () => void
  onPromote: () => void
  onDeprecate: () => void
  onAlias: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr
        className="border-t border-[var(--border)] hover:bg-[var(--bg-overlay)]/40 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <ChevronDown
              className={`w-3 h-3 text-[var(--text-faint)] transition-transform ${open ? '' : '-rotate-90'}`}
            />
            <div>
              <div className="font-mono text-[var(--text)]">{p.predicateId}</div>
              <div className="text-[10px] text-[var(--text-muted)]">
                {p.displayLabel}
              </div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
          {p.semantics}
        </td>
        <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
          {p.datatype}
        </td>
        <td
          className={`px-3 py-2 font-mono text-[10px] ${PII_TONE[p.piiClass] ?? ''}`}
        >
          {p.piiClass}
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono ${STATUS_TONE[p.status]}`}
          >
            {p.status}
            {p.aliasedTo && (
              <span className="ml-1 text-[var(--text-muted)]">→ {p.aliasedTo}</span>
            )}
          </span>
        </td>
        <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
          {p.decayHalfLifeDays === null ? '—' : `${p.decayHalfLifeDays}d`}
        </td>
        <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-faint)]">
          {p.createdBy}
        </td>
        <td
          className="px-3 py-2 text-right whitespace-nowrap"
          onClick={(e) => e.stopPropagation()}
        >
          {p.status === 'proposed' && (
            <button
              type="button"
              onClick={onPromote}
              disabled={busy}
              className="text-[10px] text-[var(--success)] hover:underline mr-2 disabled:opacity-40"
              title="Mark as active"
            >
              <CheckCircle2 className="inline w-3 h-3 mr-0.5" /> promote
            </button>
          )}
          {p.status !== 'aliased' && p.status !== 'deprecated' && (
            <button
              type="button"
              onClick={onAlias}
              disabled={busy}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] hover:underline mr-2 disabled:opacity-40"
              title="Alias to another predicate"
            >
              <ArrowRight className="inline w-3 h-3 mr-0.5" /> alias
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] hover:underline mr-2 disabled:opacity-40"
          >
            <Edit3 className="inline w-3 h-3 mr-0.5" /> edit
          </button>
          {p.status !== 'deprecated' && (
            <button
              type="button"
              onClick={onDeprecate}
              disabled={busy}
              className="text-[10px] text-[var(--danger)] hover:underline disabled:opacity-40"
            >
              <Trash2 className="inline w-3 h-3 mr-0.5" /> deprecate
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-[var(--bg)]/40">
          <td colSpan={8} className="px-6 py-3">
            <pre className="text-[10px] font-mono whitespace-pre-wrap text-[var(--text-muted)]">
              {p.description || '(no description)'}
            </pre>
            <dl className="mt-2 grid grid-cols-2 lg:grid-cols-4 gap-2 text-[10px]">
              {p.requiresScope && (
                <Meta label="requiresScope" value={p.requiresScope} />
              )}
              {p.parentPredicateId && (
                <Meta label="parent" value={p.parentPredicateId} />
              )}
              {p.subjectClasses && p.subjectClasses.length > 0 && (
                <Meta
                  label="subjectClasses"
                  value={p.subjectClasses.join(', ')}
                />
              )}
              {p.allowedValues && p.allowedValues.length > 0 && (
                <Meta
                  label="allowedValues"
                  value={p.allowedValues.join(', ')}
                />
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono">
      <span className="text-[var(--text-faint)]">{label}:</span>{' '}
      <span className="text-[var(--text-muted)]">{value}</span>
    </div>
  )
}

function PredicateEditor({
  mode,
  existing,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  existing?: Predicate
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<Partial<Predicate>>(
    existing ?? {
      predicateId: '',
      displayLabel: '',
      description: '',
      datatype: 'string',
      semantics: 'bitemporal',
      decayHalfLifeDays: 60,
      piiClass: 'none',
    },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const url =
        mode === 'create'
          ? '/api/admin/proxy/v1/admin/predicates'
          : `/api/admin/proxy/v1/admin/predicates/${encodeURIComponent(form.predicateId!)}`
      const method = mode === 'create' ? 'POST' : 'PATCH'
      const body =
        mode === 'create'
          ? form
          : {
              displayLabel: form.displayLabel,
              description: form.description,
              datatype: form.datatype,
              semantics: form.semantics,
              decayHalfLifeDays: form.decayHalfLifeDays,
              piiClass: form.piiClass,
              requiresScope: form.requiresScope,
              parentPredicateId: form.parentPredicateId,
              subjectClasses: form.subjectClasses,
              allowedValues: form.allowedValues,
            }
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} title={mode === 'create' ? 'New predicate' : `Edit ${existing?.predicateId}`}>
      <div className="space-y-3 text-xs">
        <Field label="predicateId (snake_case)">
          <input
            value={form.predicateId ?? ''}
            disabled={mode === 'edit'}
            onChange={(e) =>
              setForm((f) => ({ ...f, predicateId: e.target.value }))
            }
            className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1 font-mono disabled:opacity-50"
            placeholder="medical_diagnosis"
          />
        </Field>
        <Field label="displayLabel">
          <input
            value={form.displayLabel ?? ''}
            onChange={(e) =>
              setForm((f) => ({ ...f, displayLabel: e.target.value }))
            }
            className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1"
          />
        </Field>
        <Field label="description (extractor card)">
          <textarea
            value={form.description ?? ''}
            onChange={(e) =>
              setForm((f) => ({ ...f, description: e.target.value }))
            }
            rows={5}
            className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1 font-mono text-[10px]"
            placeholder="TYPE: ...&#10;ADMIT: ...&#10;NOT FOR: ...&#10;VALUE: ..."
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="semantics">
            <select
              value={form.semantics}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  semantics: e.target.value as Semantics,
                }))
              }
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1"
            >
              <option value="append_only">append_only</option>
              <option value="single_active">single_active</option>
              <option value="bitemporal">bitemporal</option>
            </select>
          </Field>
          <Field label="datatype">
            <select
              value={form.datatype}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  datatype: e.target.value as Predicate['datatype'],
                }))
              }
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1"
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="date">date</option>
              <option value="datetime">datetime</option>
              <option value="enum">enum</option>
              <option value="json">json</option>
            </select>
          </Field>
          <Field label="piiClass">
            <select
              value={form.piiClass}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  piiClass: e.target.value as PiiClass,
                }))
              }
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1"
            >
              <option value="none">none</option>
              <option value="identifier">identifier</option>
              <option value="behavioral">behavioral</option>
              <option value="text">text</option>
              <option value="sensitive">sensitive</option>
            </select>
          </Field>
          <Field label="decayHalfLifeDays (null = no decay)">
            <input
              type="number"
              value={form.decayHalfLifeDays ?? ''}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  decayHalfLifeDays:
                    e.target.value === '' ? null : parseInt(e.target.value, 10),
                }))
              }
              className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1"
            />
          </Field>
        </div>
        {error && (
          <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !form.predicateId}
            className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function AliasModal({
  predicate,
  candidates,
  onClose,
  onSaved,
}: {
  predicate: Predicate
  candidates: Predicate[]
  onClose: () => void
  onSaved: () => void
}) {
  const [canonicalId, setCanonicalId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!canonicalId) return
    setBusy(true)
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/predicates/${encodeURIComponent(predicate.predicateId)}/alias`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canonicalId }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Failed ${res.status}`)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} title={`Alias ${predicate.predicateId} →`}>
      <div className="space-y-3 text-xs">
        <p className="text-[var(--text-muted)]">
          Future writes carrying <code>{predicate.predicateId}</code> will be
          rewritten to the canonical id. Past facts are not touched — operator
          should run a backfill if needed.
        </p>
        <Field label="canonicalId">
          <select
            value={canonicalId}
            onChange={(e) => setCanonicalId(e.target.value)}
            className="w-full border border-[var(--border)] rounded-md bg-[var(--bg)] px-2 py-1"
          >
            <option value="">— pick a canonical predicate —</option>
            {candidates.map((c) => (
              <option key={c.predicateId} value={c.predicateId}>
                {c.predicateId} · {c.displayLabel}
              </option>
            ))}
          </select>
        </Field>
        {error && (
          <div className="text-xs text-[var(--danger)] font-mono">{error}</div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <XCircle className="inline w-3 h-3 mr-1" /> cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !canonicalId}
            className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Alias'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-md p-4 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-[var(--text)] mb-3">
          {title}
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {label}
      </div>
      {children}
    </div>
  )
}
