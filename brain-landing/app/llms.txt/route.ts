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

INITE Brain is a per-tenant bitemporal knowledge graph for AI agents. Every
fact carries two clocks — valid time (when it was true) and transaction time
(when Brain learned it) — so you can query "now" or replay what the graph
knew at any past moment. Retrieval is a graph-aware pipeline (hybrid fusion,
HyPE, predicate router, edge expansion, PPR, cross-encoder, listwise rerank),
not a single cosine match. Conflicts are scored, not silently overwritten.
GDPR forget is a synchronous hard delete that leaves only an HMAC tombstone.
Exposed over REST and a native MCP endpoint. Licensed AGPL-3.0; self-host
with Docker or use the managed endpoint at ${SITE_URL}.

## Key facts
- License: AGPL-3.0 (open source). Repository: ${GITHUB_URL}
- Surfaces: REST API + native MCP (Streamable HTTP), per tenant
- Stack: NestJS, SurrealDB, BGE-M3 embeddings, OpenAI, Cohere rerank
- Eval (n=262): recall@1 0.962, recall@3 0.989, MRR 0.976, NDCG@10 0.973;
  faithfulness / identity-F1 / memory-lifecycle / PII-gating all 1.000
- Run it: self-host (docker compose) or managed at ${SITE_URL}

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
