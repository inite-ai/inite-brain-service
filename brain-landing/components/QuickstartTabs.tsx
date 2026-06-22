'use client'

import { useState } from 'react'
import { SectionHeading } from './DualPath'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

const TABS = [
  {
    id: 'curl',
    label: 'curl',
    code: `# Ingest a fact
curl -X POST https://brain.inite.ai/v1/ingest/fact \\
  -H "Authorization: Bearer $BRAIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "entityRef": { "vertical": "rent", "id": "cust_42" },
    "predicate": "complained_about",
    "object": "late maintenance",
    "validFrom": "2026-05-05T10:00:00Z",
    "source": { "vertical": "rent", "messageId": "msg_1" }
  }'

# Search
curl -X POST https://brain.inite.ai/v1/search \\
  -H "Authorization: Bearer $BRAIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "query": "maintenance issues", "limit": 5 }'`,
  },
  {
    id: 'sdk',
    label: '@inite/knowledge',
    code: `import { BrainClient } from '@inite/knowledge'

const brain = new BrainClient({
  baseUrl: 'https://brain.inite.ai',
  apiKey: process.env.BRAIN_KEY,
})

await brain.ingestFact({
  entityRef: { vertical: 'rent', id: 'cust_42' },
  predicate: 'complained_about',
  object: 'late maintenance',
  validFrom: '2026-05-05T10:00:00Z',
  source: { vertical: 'rent', messageId: 'msg_1' },
})

const hits = await brain.search({
  query: 'maintenance issues',
  limit: 5,
})`,
  },
  {
    id: 'mcp',
    label: 'MCP',
    code: `# Claude Desktop
# ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "brain": {
      "url": "https://brain.inite.ai/mcp/<companyId>",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <api-key>"
      }
    }
  }
}

# Restart Claude. Six tools become available:
#   search_knowledge, get_entity_profile,
#   get_entity_timeline, find_related_entities,
#   record_fact, retract_fact`,
  },
]

export function QuickstartTabs({ lang }: Props) {
  const t = getMessages(lang)
  const [active, setActive] = useState(TABS[0].id)
  const current = TABS.find((tab) => tab.id === active) ?? TABS[0]
  return (
    <section className="py-16 border-t border-[var(--border)]">
      <SectionHeading
        index="04"
        eyebrow={t.quickstart.eyebrow}
        title={t.quickstart.title}
        subtitle={t.quickstart.subtitle}
      />

      <div className="mt-8 lab-panel rounded-xl overflow-hidden">
        {/* terminal chrome */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 bg-[var(--bg-overlay)]/40">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--border-strong)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--border-strong)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--border-strong)]" />
          </div>
          <div role="tablist" aria-label="Quickstart" className="flex gap-1">
            {TABS.map((tab) => {
              const isActive = tab.id === active
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActive(tab.id)}
                  className={`px-3 py-1 rounded u-mono text-[11.5px] tracking-wide transition-colors ${
                    isActive
                      ? 'bg-[var(--signal-faint)] text-[var(--signal)]'
                      : 'text-[var(--text-faint)] hover:text-[var(--text-muted)]'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
        </div>
        <pre className="px-4 py-4 text-[12px] leading-relaxed u-mono text-[var(--text)] overflow-x-auto">
          {current.code}
        </pre>
      </div>
    </section>
  )
}
