import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

export function McpInstall({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-12 border-t border-[var(--border)]">
      <h2 className="text-lg font-semibold text-[var(--text)] tracking-tight">
        {t.mcpBlock.title}
      </h2>
      <p className="mt-2 text-sm text-[var(--text-muted)]">{t.mcpBlock.subtitle}</p>

      <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] text-[11px] font-mono text-[var(--text-faint)]">
          claude_desktop_config.json
        </div>
        <pre className="px-4 py-4 text-[12px] leading-relaxed font-mono text-[var(--text)] overflow-x-auto">{`{
  "mcpServers": {
    "brain": {
      "url": "https://brain.inite.ai/mcp/<companyId>",
      "transport": "http",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}`}</pre>
      </div>

      <div className="mt-4">
        <Link
          href={`/${lang}/docs/mcp/setup`}
          className="text-sm text-[var(--accent)] hover:underline inline-flex items-center gap-1"
        >
          {t.mcpBlock.linkLabel}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </section>
  )
}
