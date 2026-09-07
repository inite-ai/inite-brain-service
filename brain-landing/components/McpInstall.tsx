import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'

const TOOLS = ['search_knowledge', 'search_multi_hop', 'memory_diff', 'synthesize', 'ingest_document', 'record_decision']

export function McpInstall({ lang }: { lang: Lang }) {
  const { mcpBlock: m } = getMessages(lang)
  return (
    <section className="pb-16 grid lg:grid-cols-2 gap-8">
      <div>
        <h2 className="text-xl font-semibold">{m.title}</h2>
        <p className="mt-3 text-sm leading-relaxed text-[var(--text-muted)]">{m.subtitle}</p>
        <Link href={`/${lang}/docs/mcp/setup`} className="mt-3 min-h-11 inline-flex items-center gap-2 text-sm text-[var(--signal)] hover:underline">
          {m.linkLabel}<ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
      <div>
        <h3 className="text-sm text-[var(--text-muted)]">{m.toolsLabel}</h3>
        <ul className="mt-3 grid sm:grid-cols-2 gap-x-4">
          {TOOLS.map((tool) => <li key={tool} className="u-mono py-2 border-b border-[var(--border)] text-xs text-[var(--data)]">{tool}</li>)}
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-[var(--text-faint)]">{m.clients}</p>
      </div>
    </section>
  )
}
