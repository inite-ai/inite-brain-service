import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

const TOOLS = [
  'search_knowledge',
  'get_entity_profile',
  'get_entity_timeline',
  'find_related_entities',
  'record_fact',
  'retract_fact',
]

export function McpInstall({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading
        index="05"
        eyebrow={t.mcpBlock.eyebrow}
        title={t.mcpBlock.title}
        subtitle={t.mcpBlock.subtitle}
      />

      <div className="mt-8 grid lg:grid-cols-2 gap-4">
        <div className="lab-panel rounded-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border)] u-mono text-[11px] text-[var(--text-faint)]">
            claude_desktop_config.json
          </div>
          <pre className="px-4 py-4 text-[12px] leading-relaxed u-mono text-[var(--text)] overflow-x-auto">{`{
  "mcpServers": {
    "brain": {
      "url": "https://brain.inite.ai/mcp/<companyId>",
      "transport": "http",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}`}</pre>
        </div>

        <div className="lab-panel rounded-xl p-5">
          <div className="u-eyebrow">{t.mcpBlock.toolsLabel}</div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {TOOLS.map((tool) => (
              <div
                key={tool}
                className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 u-mono text-[11.5px] text-[var(--text-muted)]"
              >
                <span className="w-1 h-1 rounded-full bg-[var(--data)]" />
                {tool}
              </div>
            ))}
          </div>
          <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--text-faint)]">
            {t.mcpBlock.clients}
          </p>
          <Link
            href={`/${lang}/docs/mcp/setup`}
            className="mt-4 inline-flex items-center gap-1 text-sm text-[var(--signal)] hover:underline u-mono"
          >
            {t.mcpBlock.linkLabel}
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </section>
  )
}
