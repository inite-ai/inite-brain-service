import { SITE_URL, GITHUB_URL, ORG } from '../../lib/seo'
import { getMessages } from '../../lib/i18n'
import { DOCS_PAGES } from '../../lib/docs-nav'
import { listBlogPosts } from '../../lib/blog'

export const dynamic = 'force-static'

/**
 * /llms.txt — the long-form markdown guide AI engines fetch to understand
 * the site (llmstxt.org). Generated from the same nav + content the humans
 * see, so it never drifts.
 */
export function GET() {
  const t = getMessages('en')
  const docs = DOCS_PAGES.map((p) => {
    const meta = t.docs.pages[p.key as keyof typeof t.docs.pages]
    return `- [${meta?.title ?? p.slug}](${SITE_URL}/en/docs/${p.slug}): ${meta?.description ?? ''}`
  }).join('\n')

  const posts = listBlogPosts('en')
    .map((p) => `- [${p.title}](${SITE_URL}/en/blog/${p.slug}): ${p.description}`)
    .join('\n')

  const body = `# INITE Brain

> ${ORG.description}

Brain connects typed facts, source episodes, derived scenes and beliefs, and
pointers to supporting evidence. Temporal history records when a fact held
and when it was learned. Conflicts can supersede a prior fact or remain
COMPETING. Synthesis cites evidence and can abstain in strict mode.
Scene, belief and evidence features depend on server configuration and
installed domain packs. Media registration stores references and metadata;
processing requires a configured processor.

## Key facts
- License: AGPL-3.0-or-later. Repository: ${GITHUB_URL}
- Surfaces: REST API + MCP (Streamable HTTP), per tenant
- Stdio connector: npx -y @inite/brain-mcp
- Memory scope: pass userId for personal memory; omit for tenant-global only
- Domain packs: vocabulary, scene schemas, state transitions and promotion rules
- Code memory: record_decision, why, recall_decisions
- Evaluation: LoCoMo, LongMemEval and BEAM measure different axes.
  Read ${GITHUB_URL}/blob/main/docs/eval-protocol.md for the strict binary
  judge, own full-context baseline, paired statistics and held-out split.
  Published results describe specific runs, not every deployment.
- Run it: self-host with configured providers or use the managed service

## Documentation
${docs}

## Blog
${posts}

## Links
- Docs: ${SITE_URL}/en/docs
- OpenAPI: ${SITE_URL}/openapi.json
- Source (AGPL-3.0): ${GITHUB_URL}
- Managed endpoint: ${SITE_URL}
`

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
