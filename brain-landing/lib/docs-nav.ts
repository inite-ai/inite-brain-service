/**
 * Source of truth for the docs sidebar and the docs landing index.
 *
 * Adding a new docs page:
 * 1. Add an entry here (slug = the route segment under `/docs/`).
 * 2. Drop `brain-landing/app/[lang]/docs/<slug>/page.mdx`.
 *    (Nested slugs like `concepts/bitemporal` use a `/` and resolve to
 *    `concepts/bitemporal/page.mdx`.)
 * 3. Add localized title / description in `locales/<lang>/common.json`
 *    under `docs.pages.<slug-key>`.
 * 4. The sidebar, landing cards, and prev/next pager pick it up.
 */

export interface DocPage {
  /** Route segment, can be nested via `/`. */
  slug: string
  /** Key in `locales/<lang>/common.json` → `docs.pages.<key>`. */
  key: string
}

export interface DocGroup {
  /** Key in `locales/<lang>/common.json` → `docs.groups.<key>`. */
  headingKey: 'start' | 'concepts' | 'rest' | 'mcp' | 'ops'
  pages: DocPage[]
}

export const DOCS_GROUPS: DocGroup[] = [
  {
    headingKey: 'start',
    pages: [{ slug: 'getting-started', key: 'getting-started' }],
  },
  {
    headingKey: 'concepts',
    pages: [
      { slug: 'concepts/bitemporal', key: 'bitemporal' },
      { slug: 'concepts/predicates', key: 'predicates' },
      { slug: 'concepts/conflict-resolution', key: 'conflict-resolution' },
    ],
  },
  {
    headingKey: 'rest',
    pages: [
      { slug: 'api/search', key: 'search' },
      { slug: 'api/synthesize', key: 'synthesize' },
      { slug: 'api/ingest', key: 'ingest' },
      { slug: 'api/multi-hop', key: 'multi-hop' },
      { slug: 'api/entities', key: 'entities' },
      { slug: 'api/retract', key: 'retract' },
    ],
  },
  {
    headingKey: 'mcp',
    pages: [
      { slug: 'mcp/setup', key: 'mcp-setup' },
      { slug: 'mcp/tools', key: 'mcp-tools' },
      { slug: 'skills', key: 'skills' },
    ],
  },
  {
    headingKey: 'ops',
    pages: [
      { slug: 'operator-playbook', key: 'operator-playbook' },
      { slug: 'security', key: 'security' },
    ],
  },
]

/** Flattened ordered list — used by the prev/next pager. */
export const DOCS_PAGES: DocPage[] = DOCS_GROUPS.flatMap((g) => g.pages)

export function adjacentDocs(currentSlug: string): {
  prev: DocPage | null
  next: DocPage | null
} {
  const idx = DOCS_PAGES.findIndex((p) => p.slug === currentSlug)
  if (idx === -1) return { prev: null, next: null }
  return {
    prev: idx > 0 ? DOCS_PAGES[idx - 1] : null,
    next: idx < DOCS_PAGES.length - 1 ? DOCS_PAGES[idx + 1] : null,
  }
}

export function findDocPage(slug: string): DocPage | null {
  return DOCS_PAGES.find((p) => p.slug === slug) ?? null
}
