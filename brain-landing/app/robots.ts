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

const APP_PATHS = ['/api/', '/en/admin/', '/ru/admin/', '/admin/', '/auth/']

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
