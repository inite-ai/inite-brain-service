import type { getMessages } from '../../../lib/i18n'
import type {
  SourceAvailability,
  SourceConnection,
} from '../../../lib/contracts/admin-source-connections'

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

export function statusTone(status: SourceConnection['status']): string {
  switch (status) {
    case 'active':
      return 'text-[var(--success)] bg-[var(--success)]/10'
    case 'paused':
      return 'text-[var(--warning)] bg-[var(--warning)]/10'
    default:
      return 'text-[var(--text-faint)] bg-[var(--bg-overlay)]'
  }
}

export function syncTone(status: string): string {
  if (status === 'succeeded') return 'text-[var(--success)]'
  if (status === 'failed') return 'text-[var(--danger)]'
  return 'text-[var(--warning)]'
}

export function availabilityTone(a: SourceAvailability): string {
  switch (a) {
    case 'ready':
      return 'text-[var(--success)] bg-[var(--success)]/10'
    case 'disabled':
      return 'text-[var(--warning)] bg-[var(--warning)]/10'
    case 'missing':
      return 'text-[var(--danger)] bg-[var(--danger)]/10'
    default:
      return 'text-[var(--text-muted)] bg-[var(--bg-overlay)]'
  }
}

/**
 * What the token line says: a grant with a refresh token renews itself;
 * one without lasts as long as its access token — until the expiry the
 * provider named, or, when it named none (Notion's tokens do not
 * expire), until the operator disconnects it.
 */
export function tokenWords(
  g: { refreshable: boolean; accessExpiresAt: string | null },
  a: { refreshable: string; notRefreshable: string; noExpiry: string },
): string {
  if (g.refreshable) return a.refreshable
  return g.accessExpiresAt ? fill(a.notRefreshable, { at: stamp(g.accessExpiresAt) }) : a.noExpiry
}
