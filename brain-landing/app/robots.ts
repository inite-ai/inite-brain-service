import type { MetadataRoute } from 'next'
import { SITE_URL } from '../lib/seo'

/**
 * Per-bot policy. Three buckets:
 *
 *   ALLOW (citation-grade) — crawlers that drive cited-answer traffic.
 *   We want Brain quoted by Perplexity / ChatGPT / Claude search.
 *
 *   TRAINING-ONLY (Disallow) — opt out of being absorbed into training
 *   sets while staying citation-eligible via the SearchBot variants.
 *
 *   HOSTILE (Disallow) — no citation upside, heavy load.
 *
 * The default `*` agent serves classic Googlebot / Bingbot and blocks the
 * app surfaces (api / admin / auth).
 */

/**
 * Not-for-crawling surfaces.
 *
 * /v1/ and /mcp belong to the backend, and they are POST-only and key-gated. A
 * crawler only ever issues GET, so every one of those URLs is a permanent 404
 * to anything that walks it — while .well-known/agent-actions publishes the
 * full list of them by design, as the machine-readable manifest agents are
 * meant to read. Google read it too and walked the URLs: /v1/search,
 * /v1/dreams/run, /v1/facts/:id/retract and /v1/entities/:id/forget all landed
 * in the 2026-08 not-found report, the last two with the literal `:id`
 * placeholder still in the path.
 *
 * The manifest itself stays crawlable — that is the point of publishing it,
 * and an agent calling an endpoint it names is making an API call, not a
 * crawl. What stops here is a search crawler treating an API as pages.
 */
const APP_PATHS = ['/api/', '/v1/', '/mcp', '/en/admin/', '/ru/admin/', '/admin/', '/auth/']

const CITATION_GRADE = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'MistralAI-User',
  'Kagibot',
  'Brave-SearchBot',
  'xAI-Bot',
  'YouBot',
]

const TRAINING_ONLY = ['GPTBot', 'ClaudeBot', 'bingbot-Extended']

const HOSTILE = [
  'anthropic-ai',
  'Bytespider',
  'Meta-ExternalAgent',
  'FacebookBot',
  'Amazonbot',
  'cohere-ai',
  'Diffbot',
  'Omgilibot',
  'Webzio-Extended',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: APP_PATHS },
      ...CITATION_GRADE.map((userAgent) => ({
        userAgent,
        allow: '/',
        disallow: APP_PATHS,
      })),
      ...TRAINING_ONLY.map((userAgent) => ({ userAgent, disallow: '/' })),
      ...HOSTILE.map((userAgent) => ({ userAgent, disallow: '/' })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
