'use client'

/* eslint-disable react/jsx-no-literals -- TODO i18n: end-user /app pages ship English-only for MVP (admin UI is too); queued for a dedicated i18n pass. */

import { useParams } from 'next/navigation'
import { McpInstall } from '../../../../components/McpInstall'
import { QuickstartTabs } from '../../../../components/QuickstartTabs'
import { normalizeLang } from '../../../../lib/i18n'

/**
 * Keys & integrations — how to connect to brain. For now this surfaces
 * the MCP connection config and SDK quickstart (read-only). Brain keys
 * are issued per company, not per user, so self-serve per-user key CRUD
 * is a later backend increment; today this is the onboarding surface.
 */
export default function KeysPage() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">
          Keys &amp; integrations
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Connect your agents and tools to this brain. Use the MCP config for
          Claude Desktop, Cursor, and other MCP hosts, or the SDK quickstart
          for direct API access.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">MCP</h2>
        <McpInstall lang={lang} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Quickstart</h2>
        <QuickstartTabs lang={lang} />
      </section>

      <p className="text-xs text-[var(--text-faint)]">
        Brain keys are scoped to your company. Need a new key or per-user
        scopes? Contact your workspace admin.
      </p>
    </div>
  )
}
