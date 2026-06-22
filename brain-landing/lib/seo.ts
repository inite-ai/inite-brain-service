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

type Json = Record<string, unknown>

export function organizationSchema(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: ORG.name,
    url: ORG.url,
    logo: ORG.logo,
    description: ORG.description,
    sameAs: ORG.sameAs,
  }
}

export function websiteSchema(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: ORG.name,
    url: SITE_URL,
    inLanguage: ['en', 'ru'],
    publisher: { '@type': 'Organization', name: ORG.name, url: SITE_URL },
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
