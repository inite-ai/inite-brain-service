/**
 * SEO / AEO constants + JSON-LD builders. One source of truth for the
 * site identity that every structured-data block and the llms.txt / ai.txt
 * routes read from, so the machine-readable surface never drifts from the
 * human one.
 */

export const SITE_URL = 'https://brain.inite.ai'
export const REPO = 'inite-ai/inite-brain-service'
export const GITHUB_URL = `https://github.com/${REPO}`

/**
 * The company Brain belongs to: INITE (inite LLC), https://inite.ai.
 *
 * The footer link below is the only crawlable edge from Brain to the company.
 * JSON-LD states a relationship; it does not carry one. Every MCP catalogue
 * that lists this server (pulsemcp, mcphq, mcp-marketplace, roninforge)
 * points at brain.inite.ai, and from here nothing pointed on — the whole
 * family's earned links dead-ended on a subdomain.
 *
 * This constant is the one place its address lives.
 */
export const PARENT = {
  name: 'INITE',
  legalName: 'inite LLC',
  url: 'https://inite.ai',
} as const

export const ORG = {
  name: 'INITE Brain',
  url: SITE_URL,
  logo: `${SITE_URL}/favicon.ico`,
  description:
    'Open-source memory for AI agents: facts, episodes, scenes and evidence, with temporal history, conflict resolution and retrieval over REST and MCP.',
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
 * The company, by @id, as every family site names it: described in full on
 * inite.ai only, with enough here to resolve on its own.
 *
 * Owner, 13.11.2026: there is one company, inite LLC, and Brain is its
 * product. This site declares no Organization of its own, no
 * `parentOrganization`, and no `sameAs` to family sites. The graph below is
 * the family registry's for `brain` (@inite/landing `familySchema`).
 */
export const COMPANY_ID = `${PARENT.url}/#organization`
const COMPANY = { '@id': COMPANY_ID }
export const COMPANY_REF = { '@type': 'Organization', '@id': COMPANY_ID, name: PARENT.name, url: PARENT.url }

/** The product's line in the family registry (@inite/landing locales/<lang>/family.json). */
const FAMILY_LINE: Record<'en' | 'ru', string> = {
  en: 'Facts, time, provenance, conflicts and relationships.',
  ru: 'Факты, источники, история изменений и связи.',
}

const familyLang = (lang: string): 'en' | 'ru' => (lang === 'ru' ? 'ru' : 'en')

/** The site's WebSite node; its publisher is the company. */
export function websiteSchema(lang: string = 'en'): Json {
  return {
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: SITE_URL,
    name: ORG.name,
    publisher: COMPANY,
    inLanguage: familyLang(lang),
    about: { '@id': `${SITE_URL}/#app` },
  }
}

/**
 * The landing's graph: WebSite, the product (SoftwareApplication), its Brand
 * and the company stub.
 */
export function familySchema(lang: string = 'en'): Json {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      websiteSchema(lang),
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#app`,
        name: ORG.name,
        url: SITE_URL,
        description: FAMILY_LINE[familyLang(lang)],
        provider: COMPANY,
        brand: { '@id': `${SITE_URL}/#brand` },
        publisher: COMPANY,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        // Product facts, not about the organization: kept.
        softwareHelp: `${SITE_URL}/en/docs`,
        license: 'https://www.gnu.org/licenses/agpl-3.0.html',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        codeRepository: GITHUB_URL,
        programmingLanguage: 'TypeScript',
      },
      { '@type': 'Brand', '@id': `${SITE_URL}/#brand`, name: ORG.name, url: SITE_URL },
      { ...COMPANY_REF },
    ],
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
    author: { ...COMPANY_REF },
    publisher: { ...COMPANY_REF },
    ...(a.image ? { image: [a.image] } : {}),
    articleSection: a.section,
    keywords: a.keywords.join(', '),
    inLanguage: a.lang,
    isPartOf: { '@id': `${SITE_URL}/#website` },
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
