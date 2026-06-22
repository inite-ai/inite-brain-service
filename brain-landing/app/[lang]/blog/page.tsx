import Link from 'next/link'
import type { Metadata } from 'next'
import { ArrowRight } from 'lucide-react'
import { JsonLd } from '../../../components/StructuredData'
import { getMessages, normalizeLang, LANGS, type Lang } from '../../../lib/i18n'
import { listBlogPosts } from '../../../lib/blog'
import { SITE_URL, breadcrumbSchema, websiteSchema } from '../../../lib/seo'

interface Props {
  params: Promise<{ lang: string }>
}

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  const t = getMessages(lang)
  const url = `${SITE_URL}/${lang}/blog`
  return {
    title: `${t.blog.title} — INITE Brain`,
    description: t.blog.subtitle,
    alternates: {
      canonical: url,
      languages: Object.fromEntries(LANGS.map((l) => [l, `${SITE_URL}/${l}/blog`])),
    },
    openGraph: { title: t.blog.title, description: t.blog.subtitle, url, type: 'website' },
  }
}

export default async function BlogIndex({ params }: Props) {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  const t = getMessages(lang)
  const posts = listBlogPosts(lang)

  const blogSchema = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${t.blog.title} — INITE Brain`,
    url: `${SITE_URL}/${lang}/blog`,
    inLanguage: lang,
    isPartOf: websiteSchema(),
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: `${SITE_URL}/${lang}/blog/${p.slug}`,
      datePublished: p.date,
      description: p.description,
    })),
  }
  const breadcrumb = breadcrumbSchema([
    { name: 'Home', url: `${SITE_URL}/${lang}` },
    { name: t.nav.blog, url: `${SITE_URL}/${lang}/blog` },
  ])

  return (
    <>
      <JsonLd data={[blogSchema, breadcrumb]} />

      <div className="flex items-center gap-3">
        <span className="u-eyebrow">{t.nav.blog}</span>
        <span className="flex-1 lab-rule" />
      </div>
      <h1 className="u-display mt-3 text-3xl font-bold tracking-[-0.01em] text-[var(--text)]">
        {t.blog.title}
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-muted)]">
        {t.blog.subtitle}
      </p>

      <div className="mt-8 space-y-3">
        {posts.map((p) => (
          <Link
            key={p.slug}
            href={`/${lang}/blog/${p.slug}`}
            className="lab-panel group block rounded-xl p-5 hover:border-[var(--border-strong)] transition-colors"
          >
            <div className="flex items-center gap-2 u-mono text-[10.5px] text-[var(--text-faint)]">
              <span className="text-[var(--data)] uppercase tracking-[0.14em]">{p.category}</span>
              <span aria-hidden>·</span>
              <span>{p.date}</span>
              <span aria-hidden>·</span>
              <span>{t.blog.readTime.replace('{n}', String(p.readingMinutes))}</span>
            </div>
            <h2 className="u-display mt-2 text-lg font-semibold text-[var(--text)] group-hover:text-[var(--signal)] transition-colors">
              {p.title}
            </h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--text-muted)]">
              {p.description}
            </p>
            <span className="mt-3 inline-flex items-center gap-1 u-mono text-[12px] text-[var(--signal)]">
              {t.blog.read}
              <ArrowRight className="w-3.5 h-3.5 -translate-x-1 group-hover:translate-x-0 transition-transform" />
            </span>
          </Link>
        ))}
      </div>
    </>
  )
}
