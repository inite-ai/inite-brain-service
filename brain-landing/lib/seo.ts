/**
 * SEO / AEO constants + JSON-LD builders. One source of truth for the
 * site identity that every structured-data block and the llms.txt / ai.txt
 * routes read from, so the machine-readable surface never drifts from the
 * human one.
 */

export const SITE_URL = 'https://brain.inite.ai'
export const REPO = 'inite-ai/inite-brain-service'
export const GITHUB_URL = `https://github.com/${REPO}`

export const ORG = {
  name: 'INITE Brain',
  url: SITE_URL,
  logo: `${SITE_URL}/favicon.ico`,
  description:
    'Open-source bitemporal knowledge graph for AI agents — semantic memory with hybrid retrieval, conflict-aware ingest and GDPR forget, over REST and MCP.',
  sameAs: [GITHUB_URL],
}

/** Build a dynamic OG image URL served by /api/og. */
export function ogImage(opts: { title: string; kicker?: string; kind?: 'brand' | 'blog' | 'docs' }): string {
  const p = new URLSearchParams({ title: opts.title, kind: opts.kind ?? 'brand' })
  if (opts.kicker) p.set('kicker', opts.kicker)
  return `${SITE_URL}/api/og?${p.toString()}`
}

type Json = Record<string, unknown>

/**
 * INITE Brain, as an entity anything can point at.
 *
 * The node had no `@id` and no parent. inite.ai lists seventeen brands as
 * `subOrganization`, one of them https://brain.inite.ai/#organization — and
 * with nothing declaring it, that reference resolved to nothing and Brain read
 * as a company nobody had heard of that happens to share a word in its name.
 *
 * `sameAs` carries the family handles as well as the repository, for the same
 * reason: they are how a search engine ties this domain to the rest.
 */
export function organizationSchema(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: ORG.name,
    url: ORG.url,
    logo: ORG.logo,
    description: ORG.description,
    sameAs: [
      ...ORG.sameAs,
      'https://inite.ai',
      'https://www.linkedin.com/company/inite-ai/',
      'https://t.me/initeai',
      'https://github.com/inite-ai',
    ],
    parentOrganization: {
      '@type': 'Organization',
      '@id': 'https://inite.ai/#organization',
      name: 'INITE',
      legalName: 'inite LLC',
      url: 'https://inite.ai',
    },
  }
}

export function websiteSchema(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: ORG.name,
    url: SITE_URL,
    inLanguage: ['en', 'ru'],
    // By reference: the full node is emitted once by organizationSchema, and a
    // second copy here would be free to drift from it.
    publisher: { '@id': `${SITE_URL}/#organization` },
  }
}

/** Brain is a developer tool → SoftwareApplication / DeveloperApplication. */
export function softwareApplicationSchema(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: ORG.name,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, Docker',
    description: ORG.description,
    url: SITE_URL,
    softwareHelp: `${SITE_URL}/en/docs`,
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    codeRepository: GITHUB_URL,
    programmingLanguage: 'TypeScript',
    sameAs: ORG.sameAs,
  }
}

export interface ArticleInput {
  title: string
  description: string
  url: string
  datePublished: string
  dateModified?: string
  author: string
  image?: string
  section: string
  keywords: string[]
  lang: string
}

export function articleSchema(a: ArticleInput): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: a.title,
    description: a.description,
    url: a.url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': a.url },
    datePublished: a.datePublished,
    dateModified: a.dateModified || a.datePublished,
    author: { '@type': 'Organization', name: a.author, url: SITE_URL },
    publisher: organizationSchema(),
    ...(a.image ? { image: [a.image] } : {}),
    articleSection: a.section,
    keywords: a.keywords.join(', '),
    inLanguage: a.lang,
    isPartOf: websiteSchema(),
  }
}

export function faqSchema(faqs: { question: string; answer: string }[]): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  }
}

export function breadcrumbSchema(items: { name: string; url: string }[]): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  }
}
