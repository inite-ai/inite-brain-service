'use client'

import { useState } from 'react'
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
    <section className="py-12 border-t border-[var(--border)]">
      <h2 className="text-lg font-semibold text-[var(--text)] tracking-tight">
        {t.quickstart.title}
      </h2>
      <p className="mt-2 text-sm text-[var(--text-muted)]">{t.quickstart.subtitle}</p>

      <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
        <div
          role="tablist"
          aria-label="Quickstart"
          className="flex border-b border-[var(--border)]"
        >
          {TABS.map((tab) => {
            const isActive = tab.id === active
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(tab.id)}
                className={`px-4 py-2 text-[12px] font-mono tracking-wide ${
                  isActive
                    ? 'text-[var(--text)] border-b-2 border-[var(--accent)] -mb-px'
                    : 'text-[var(--text-faint)] hover:text-[var(--text-muted)]'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        <pre className="px-4 py-4 text-[12px] leading-relaxed font-mono text-[var(--text)] overflow-x-auto">
          {current.code}
        </pre>
      </div>
    </section>
  )
}
