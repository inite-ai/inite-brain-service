import type { getMessages } from '../../../lib/i18n'

export type AdminT = ReturnType<typeof getMessages>['admin']
export type ConnectionsT = AdminT['connections']

export function errorMessage(json: unknown, status: number): string {
  const j = json as { message?: unknown; error?: unknown } | null
  if (typeof j?.message === 'string') return j.message
  if (typeof j?.error === 'string') return j.error
  return `Failed ${status}`
}

export function stamp(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ')
}

export function fill(template: string, vars: Record<string, string | number>): string {
  let out = template
  for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v))
  return out
}

export const PROXY = '/api/admin/proxy/v1/admin/source-connections'

export function connectionPath(id: string, suffix = ''): string {
  return `${PROXY}/${encodeURIComponent(id)}${suffix}`
}

export const btnCls =
  'px-1.5 py-0.5 rounded text-[10px] inline-flex items-center gap-1 disabled:opacity-40'
export const accentBtn = `${btnCls} bg-[var(--accent)]/10 text-[var(--accent)]`
export const mutedBtn = `${btnCls} bg-[var(--bg-overlay)] text-[var(--text-muted)]`
export const dangerBtn = `${btnCls} bg-[var(--danger)]/10 text-[var(--danger)]`
