import type { MetadataRoute } from 'next'
import { execSync } from 'node:child_process'
import { SITE_URL } from '../lib/seo'
import { LANGS } from '../lib/i18n'
import { DOCS_PAGES } from '../lib/docs-nav'
import { getBlogSlugs } from '../lib/blog'

// Last-modified from the git history of the source file — the most accurate
// "content changed" signal there is. Wrapped in try/catch for build envs
// that run outside a checkout.
function gitMtime(relPath: string): Date | undefined {
  try {
    const iso = execSync(`git log -1 --format=%cI -- "${relPath}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    if (iso) return new Date(iso)
  } catch {
    /* git unavailable or untracked — leave undefined */
  }
  return undefined
}

function alternates(pathNoLang: string) {
  return {
    languages: Object.fromEntries(
      LANGS.map((l) => [l, `${SITE_URL}/${l}${pathNoLang}`]),
    ),
  }
}

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = []

  // root
  entries.push({ url: SITE_URL, changeFrequency: 'weekly', priority: 1.0 })

  const blogSlugs = getBlogSlugs()

  for (const lang of LANGS) {
    // home
    entries.push({
      url: `${SITE_URL}/${lang}`,
      lastModified: gitMtime('app/[lang]/page.tsx'),
      changeFrequency: 'weekly',
      priority: 1.0,
      alternates: alternates(''),
    })
    // docs index
    entries.push({
      url: `${SITE_URL}/${lang}/docs`,
      changeFrequency: 'weekly',
      priority: 0.8,
      alternates: alternates('/docs'),
    })
    // docs pages
    for (const page of DOCS_PAGES) {
      entries.push({
        url: `${SITE_URL}/${lang}/docs/${page.slug}`,
        lastModified: gitMtime(`app/[lang]/docs/${page.slug}/page.mdx`),
        changeFrequency: 'monthly',
        priority: 0.6,
        alternates: alternates(`/docs/${page.slug}`),
      })
    }
    // blog index
    entries.push({
      url: `${SITE_URL}/${lang}/blog`,
      changeFrequency: 'weekly',
      priority: 0.7,
      alternates: alternates('/blog'),
    })
    // blog posts
    for (const slug of blogSlugs) {
      entries.push({
        url: `${SITE_URL}/${lang}/blog/${slug}`,
        lastModified: gitMtime(`content/blog/en/${slug}.mdx`),
        changeFrequency: 'monthly',
        priority: 0.7,
        alternates: alternates(`/blog/${slug}`),
      })
    }
  }

  return entries
}
