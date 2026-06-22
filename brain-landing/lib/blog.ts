import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import readingTime from 'reading-time'
import { LANGS, DEFAULT_LANG, type Lang } from './i18n'

/**
 * File-system blog collection. Posts live at
 * `content/blog/<lang>/<slug>.mdx` with rich AEO frontmatter (directAnswer,
 * definitionSentence, faqs) that feeds Article + FAQPage JSON-LD. English
 * is the canonical set; a missing localized file falls back to English so
 * every slug resolves under every language.
 *
 * All reads happen at build time (pages are statically generated), so there
 * is no fs access on the request path in production.
 */

const BLOG_DIR = path.join(process.cwd(), 'content', 'blog')

export interface BlogFaq {
  question: string
  answer: string
}

export interface BlogMeta {
  slug: string
  lang: Lang
  /** true when the localized file was missing and we fell back to English. */
  fallback: boolean
  title: string
  seoTitle?: string
  description: string
  date: string
  author: string
  category: string
  tags: string[]
  directAnswer?: string
  definitionSentence?: string
  statisticalFacts?: string[]
  faqs?: BlogFaq[]
  cover?: string
  readingMinutes: number
}

export interface BlogPost extends BlogMeta {
  content: string
}

function langDir(lang: Lang): string {
  return path.join(BLOG_DIR, lang)
}

function readRaw(slug: string, lang: Lang): { raw: string; lang: Lang } | null {
  const direct = path.join(langDir(lang), `${slug}.mdx`)
  if (fs.existsSync(direct)) return { raw: fs.readFileSync(direct, 'utf8'), lang }
  const fallback = path.join(langDir(DEFAULT_LANG), `${slug}.mdx`)
  if (fs.existsSync(fallback)) return { raw: fs.readFileSync(fallback, 'utf8'), lang: DEFAULT_LANG }
  return null
}

function toMeta(slug: string, requested: Lang, file: { raw: string; lang: Lang }): BlogPost {
  const { data, content } = matter(file.raw)
  return {
    slug,
    lang: requested,
    fallback: file.lang !== requested,
    title: String(data.title ?? slug),
    seoTitle: data.seoTitle ? String(data.seoTitle) : undefined,
    description: String(data.description ?? ''),
    date: String(data.date ?? ''),
    author: String(data.author ?? 'INITE Brain'),
    category: String(data.category ?? 'Engineering'),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    directAnswer: data.directAnswer ? String(data.directAnswer) : undefined,
    definitionSentence: data.definitionSentence ? String(data.definitionSentence) : undefined,
    statisticalFacts: Array.isArray(data.statisticalFacts)
      ? data.statisticalFacts.map(String)
      : undefined,
    faqs: Array.isArray(data.faqs)
      ? data.faqs.map((f: { question: string; answer: string }) => ({
          question: String(f.question),
          answer: String(f.answer),
        }))
      : undefined,
    cover: data.cover ? String(data.cover) : undefined,
    readingMinutes: Math.max(1, Math.round(readingTime(content).minutes)),
    content,
  }
}

/** All known slugs, derived from the English (canonical) directory. */
export function getBlogSlugs(): string[] {
  const dir = langDir(DEFAULT_LANG)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace(/\.mdx$/, ''))
}

export function getBlogPost(slug: string, lang: Lang): BlogPost | null {
  const file = readRaw(slug, lang)
  return file ? toMeta(slug, lang, file) : null
}

/** Post list for a language, newest first. */
export function listBlogPosts(lang: Lang): BlogMeta[] {
  return getBlogSlugs()
    .map((slug) => getBlogPost(slug, lang))
    .filter((p): p is BlogPost => p !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(({ content: _content, ...meta }) => meta)
}

/** Up to `n` related posts — shared tags first, then recency. */
export function getRelatedPosts(slug: string, lang: Lang, n = 3): BlogMeta[] {
  const current = getBlogPost(slug, lang)
  if (!current) return []
  const others = listBlogPosts(lang).filter((p) => p.slug !== slug)
  const scored = others
    .map((p) => ({
      p,
      shared: p.tags.filter((t) => current.tags.includes(t)).length,
    }))
    .sort((a, b) => b.shared - a.shared)
  return scored.slice(0, n).map((s) => s.p)
}

export { LANGS, DEFAULT_LANG }
