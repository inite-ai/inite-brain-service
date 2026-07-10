'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n migration: queued with the admin-wide pass. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, KeyRound, Plus, ScanEye } from 'lucide-react'
import type {
  PolicyRule,
  PolicySet,
  PolicySetResponse,
} from '../../../lib/contracts/admin-policies'
import { usePolicyRegistry } from './usePolicyRegistry'
import { AttachKeysDrawer } from './AttachKeysDrawer'
import { ModeBadge } from './PolicyBadges'
import { RuleRow } from './RuleRow'
import { ErrorLine, Field, Modal, Segmented, inputCls } from './ui'

interface Draft {
  name: string
  description: string
  posture: { actions: 'allow' | 'deny'; reads: 'allow' | 'deny' }
  mode: PolicySet['mode']
  rules: PolicyRule[]
}

function toDraft(s: PolicySet): Draft {
  return {
    name: s.name,
    description: s.description,
    posture: { ...s.posture },
    mode: s.mode,
    rules: s.rules.map((r) => ({ ...r, match: r.match?.map((c) => ({ ...c })) })),
  }
}

/** The Key Lens picks unsaved drafts up from here (?draft=1). */
export const DRAFT_STORAGE_KEY = 'brain.keylens.draft'

export function PolicySetEditor({ name }: { name: string }) {
  const router = useRouter()
  const params = useParams<{ lang: string }>()
  const lang = params?.lang ?? 'en'
  const { registry } = usePolicyRegistry()

  const [saved, setSaved] = useState<PolicySet | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [confirmEnforce, setConfirmEnforce] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/policy-sets/${encodeURIComponent(name)}`,
        { cache: 'no-store' },
      )
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message?.message ?? data.error ?? `Failed ${res.status}`)
      }
      const set = (data as PolicySetResponse).policySet
      setSaved(set)
      setDraft(toDraft(set))
      setConflict(false)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [name])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(() => {
    if (!saved || !draft) return false
    return JSON.stringify(toDraft(saved)) !== JSON.stringify(draft)
  }, [saved, draft])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const problems = useMemo(() => {
    if (!draft) return []
    const out: Array<{ level: 'error' | 'warn'; text: string }> = []
    const ids = new Set<string>()
    for (const r of draft.rules) {
      if (!r.id.trim()) out.push({ level: 'error', text: 'A rule is missing its id.' })
      else if (ids.has(r.id))
        out.push({ level: 'error', text: `Duplicate rule id '${r.id}'.` })
      ids.add(r.id)
      if (r.kind === 'action' && (r.actions ?? []).length === 0) {
        out.push({ level: 'error', text: `Action rule '${r.id}' selects no actions.` })
      }
      if (r.kind === 'source' && (r.match ?? []).length === 0) {
        out.push({ level: 'error', text: `Source rule '${r.id}' has no conditions.` })
      }
      for (const c of r.match ?? []) {
        const needsValue = !['exists', 'not_exists'].includes(c.op)
        const empty =
          c.value === undefined ||
          c.value === '' ||
          (Array.isArray(c.value) && c.value.length === 0)
        if (needsValue && empty) {
          out.push({
            level: 'error',
            text: `Rule '${r.id}': '${c.attr} ${c.op}' needs a value.`,
          })
        }
      }
    }
    const enabled = draft.rules.filter((r) => r.enabled)
    if (
      draft.posture.actions === 'deny' &&
      !enabled.some((r) => r.kind === 'action' && r.effect === 'allow')
    ) {
      out.push({
        level: 'warn',
        text: 'Actions default to deny with zero allow rules — attached keys can call nothing.',
      })
    }
    if (
      draft.posture.reads === 'deny' &&
      !enabled.some((r) => r.kind === 'source' && r.effect === 'allow')
    ) {
      out.push({
        level: 'warn',
        text: 'Reads default to deny with zero allow rules — attached keys see zero facts.',
      })
    }
    return out
  }, [draft])

  const blocking = problems.some((p) => p.level === 'error')

  const save = useCallback(async () => {
    if (!draft || !saved || blocking) return
    setSaving(true)
    try {
      const res = await fetch(
        `/api/admin/proxy/v1/admin/policy-sets/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...draft, version: saved.version }),
        },
      )
      const data = await res.json()
      if (res.status === 409) {
        setConflict(true)
        return
      }
      if (!res.ok) {
        throw new Error(
          data.error === 'invalid_policy_document'
            ? JSON.stringify(data.issues)
            : (data.message?.message ?? data.error ?? `Failed ${res.status}`),
        )
      }
      const set = (data as PolicySetResponse).policySet
      setSaved(set)
      setDraft(toDraft(set))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [blocking, draft, name, saved])

  const tryInKeyLens = useCallback(() => {
    if (!draft) return
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
    router.push(`/${lang}/admin/key-lens?draft=1`)
  }, [draft, lang, router])

  const setMode = (mode: PolicySet['mode']) => {
    if (!draft) return
    if (mode === 'enforce' && draft.mode !== 'enforce') {
      setConfirmEnforce(true)
      return
    }
    setDraft({ ...draft, mode })
  }

  if (!draft) {
    return (
      <div className="p-6">
        <ErrorLine error={error} />
        {!error ? (
          <p className="text-xs text-[var(--text-muted)]">loading policy set…</p>
        ) : null}
      </div>
    )
  }

  const addRule = (kind: PolicyRule['kind']) => {
    const base = `rule-${draft.rules.length + 1}`
    let id = base
    let n = 1
    while (draft.rules.some((r) => r.id === id)) id = `${base}-${n++}`
    setDraft({
      ...draft,
      rules: [
        ...draft.rules,
        kind === 'action'
          ? { id, effect: 'allow', kind, enabled: true, actions: [] }
          : { id, effect: 'deny', kind, enabled: true, match: [] },
      ],
    })
  }

  return (
    <div className="p-6 pb-24">
      <button
        type="button"
        onClick={() => router.push(`/${lang}/admin/policies`)}
        className="mb-3 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3 w-3" /> policy sets
      </button>

      {conflict ? (
        <div className="mb-4 flex items-center justify-between rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
          <span>
            This policy set changed since you loaded it — reload to see the
            latest version. Your edits stay in the form.
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-[var(--warning)]/50 px-2 py-0.5 font-medium hover:bg-[var(--warning)]/20"
          >
            Reload
          </button>
        </div>
      ) : null}
      <ErrorLine error={error} />

      <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-lg font-semibold text-[var(--text)]">
              {draft.name}
            </h1>
            <ModeBadge mode={draft.mode} />
            <span className="text-[10px] font-mono text-[var(--text-faint)]">
              v{saved?.version}
            </span>
          </div>
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="description…"
            className={`${inputCls} mb-4 max-w-xl`}
          />

          <p className="mb-2 text-[11px] text-[var(--text-muted)]">
            Rules are order-independent:{' '}
            <span className="text-[var(--danger)]">deny</span> overrides{' '}
            <span className="text-[var(--success)]">allow</span>; anything
            unmatched falls to the default posture.
          </p>

          <div className="space-y-2">
            {draft.rules.map((rule, i) => (
              <RuleRow
                key={i}
                rule={rule}
                registry={registry}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    rules: draft.rules.map((r, j) => (j === i ? next : r)),
                  })
                }
                onDuplicate={() =>
                  setDraft({
                    ...draft,
                    rules: [
                      ...draft.rules,
                      { ...rule, id: `${rule.id}-copy` },
                    ],
                  })
                }
                onDelete={() =>
                  setDraft({
                    ...draft,
                    rules: draft.rules.filter((_, j) => j !== i),
                  })
                }
              />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => addRule('action')}
              className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <Plus className="h-3 w-3" /> action rule
            </button>
            <button
              type="button"
              onClick={() => addRule('source')}
              className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <Plus className="h-3 w-3" /> source rule
            </button>
          </div>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
            <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Mode
            </h2>
            <Segmented
              value={draft.mode}
              options={[
                { value: 'report_only' as const, label: 'report only' },
                { value: 'enforce' as const, label: 'enforce' },
                { value: 'disabled' as const, label: 'off' },
              ]}
              onChange={setMode}
            />
            <h2 className="mb-2 mt-4 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Default posture
            </h2>
            <div className="space-y-2">
              <Field label="actions (unmatched calls)">
                <Segmented
                  value={draft.posture.actions}
                  options={[
                    { value: 'deny' as const, label: 'deny ✓' },
                    { value: 'allow' as const, label: 'allow' },
                  ]}
                  onChange={(v) =>
                    setDraft({ ...draft, posture: { ...draft.posture, actions: v } })
                  }
                />
              </Field>
              <Field label="reads (unmatched rows)">
                <Segmented
                  value={draft.posture.reads}
                  options={[
                    { value: 'deny' as const, label: 'deny ✓' },
                    { value: 'allow' as const, label: 'allow' },
                  ]}
                  onChange={(v) =>
                    setDraft({ ...draft, posture: { ...draft.posture, reads: v } })
                  }
                />
              </Field>
              <p className="text-[10px] text-[var(--text-faint)]">
                deny ✓ = recommended least-privilege default
              </p>
            </div>
          </div>

          {problems.length > 0 ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
              <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Validation
              </h2>
              <ul className="space-y-1">
                {problems.map((p, i) => (
                  <li
                    key={i}
                    className={`text-[11px] ${
                      p.level === 'error'
                        ? 'text-[var(--danger)]'
                        : 'text-[var(--warning)]'
                    }`}
                  >
                    {p.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Attached keys
              </h2>
              <button
                type="button"
                onClick={() => setAttachOpen(true)}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
              >
                <KeyRound className="h-3 w-3" /> Manage
              </button>
            </div>
            {saved && saved.attachedSubjects.length > 0 ? (
              <ul className="space-y-1">
                {saved.attachedSubjects.map((s) => (
                  <li key={s} className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                    {s.replace('key:sha256:', '').slice(0, 12)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-[var(--text-faint)]">
                No keys attached yet.
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={tryInKeyLens}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-[var(--accent)]/50 px-3 py-2 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10"
          >
            <ScanEye className="h-3.5 w-3.5" /> Try in Key Lens
          </button>
        </aside>
      </div>

      {dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--bg-elevated)]/95 px-6 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">
              Unsaved changes
              {blocking ? (
                <span className="text-[var(--danger)]"> · fix validation errors to save</span>
              ) : null}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => saved && setDraft(toDraft(saved))}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={saving || blocking}
                onClick={() => void save()}
                className="rounded bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {saving ? 'saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {attachOpen && saved ? (
        <AttachKeysDrawer
          policySet={saved}
          onClose={() => setAttachOpen(false)}
          onApplied={() => void load()}
        />
      ) : null}

      {confirmEnforce ? (
        <Modal title="Promote to enforce?" onClose={() => setConfirmEnforce(false)}>
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">
            Enforce mode starts BLOCKING: denied calls answer 403, denied rows
            disappear from results for every attached key. Check the Decisions
            feed for recent would-deny activity first — a clean report-only
            window is the safe signal.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmEnforce(false)}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft((d) => (d ? { ...d, mode: 'enforce' } : d))
                setConfirmEnforce(false)
              }}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white"
            >
              Switch to enforce
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
