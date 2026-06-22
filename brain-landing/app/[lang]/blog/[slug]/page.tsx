import { notFound } from 'next/navigation'
import Link from 'next/link'
import type { Metadata } from 'next'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { MDXRemote } from 'next-mdx-remote/rsc'
import remarkGfm from 'remark-gfm'
import { JsonLd } from '../../../../components/StructuredData'
import { mdxComponents } from '../../../../mdx-components'
import { getMessages, normalizeLang, LANGS } from '../../../../lib/i18n'
import { getBlogPost, getBlogSlugs, getRelatedPosts } from '../../../../lib/blog'
import {
  SITE_URL,
  articleSchema,
  faqSchema,
  breadcrumbSchema,
  ogImage,
} from '../../../../lib/seo'

export const dynamicParams = false

interface Props {
  params: Promise<{ lang: string; slug: string }>
}

export function generateStaticParams() {
  const slugs = getBlogSlugs()
  return LANGS.flatMap((lang) => slugs.map((slug) => ({ lang, slug })))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: raw, slug } = await params
  const lang = normalizeLang(raw)
  const post = getBlogPost(slug, lang)
  if (!post) return {}
  const url = `${SITE_URL}/${lang}/blog/${slug}`
  return {
    title: `${post.seoTitle ?? post.title} — INITE Brain`,
    description: post.description,
    keywords: post.tags,
    alternates: {
      canonical: url,
      languages: Object.fromEntries(
        LANGS.map((l) => [l, `${SITE_URL}/${l}/blog/${slug}`]),
      ),
    },
    openGraph: {
      title: post.title,
      description: post.description,
      url,
      type: 'article',
      publishedTime: post.date,
      authors: [post.author],
      tags: post.tags,
      images: [
        { url: ogImage({ title: post.title, kicker: post.category, kind: 'blog' }), width: 1200, height: 630 },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: post.title,
      description: post.description,
      images: [ogImage({ title: post.title, kicker: post.category, kind: 'blog' })],
    },
  }
}

export default async function BlogPostPage({ params }: Props) {
  const { lang: raw, slug } = await params
  const lang = normalizeLang(raw)
  const post = getBlogPost(slug, lang)
  if (!post) notFound()
  const t = getMessages(lang)
  const related = getRelatedPosts(slug, lang, 3)
  const url = `${SITE_URL}/${lang}/blog/${slug}`

  const schemas: object[] = [
    articleSchema({
      title: post.title,
      description: post.description,
      url,
      datePublished: post.date,
      author: post.author,
      section: post.category,
      keywords: post.tags,
      lang,
      image: ogImage({ title: post.title, kicker: post.category, kind: 'blog' }),
    }),
    breadcrumbSchema([
      { name: 'Home', url: `${SITE_URL}/${lang}` },
      { name: t.nav.blog, url: `${SITE_URL}/${lang}/blog` },
      { name: post.title, url },
    ]),
  ]
  if (post.faqs?.length) schemas.push(faqSchema(post.faqs))

  return (
    <>
      <JsonLd data={schemas} />

      <Link
        href={`/${lang}/blog`}
        className="inline-flex items-center gap-1.5 u-mono text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {t.blog.backToBlog}
      </Link>

      {post.fallback && (
        <div className="mt-4 px-3 py-2 rounded border border-[var(--border)] bg-[var(--bg-elevated)] text-[12px] text-[var(--text-muted)]">
          {t.blog.fallbackNotice}
        </div>
      )}

      <div className="mt-5 flex items-center gap-2 u-mono text-[10.5px] text-[var(--text-faint)]">
        <span className="text-[var(--data)] uppercase tracking-[0.14em]">{post.category}</span>
        <span aria-hidden>·</span>
        <span>{post.date}</span>
        <span aria-hidden>·</span>
        <span>{t.blog.readTime.replace('{n}', String(post.readingMinutes))}</span>
      </div>

      <h1 className="u-display mt-3 text-[2rem] leading-tight font-bold tracking-[-0.01em] text-[var(--text)]">
        {post.title}
      </h1>

      {post.directAnswer && (
        <aside className="mt-6 rounded-lg border-l-2 border-[var(--signal)] bg-[var(--signal-faint)] pl-4 pr-4 py-3">
          <div className="u-mono text-[10px] uppercase tracking-[0.16em] text-[var(--signal)]">
            {t.blog.directAnswer}
          </div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--text)]">
            {post.directAnswer}
          </p>
        </aside>
      )}

      <article className="docs-content mt-8">
        <MDXRemote
          source={post.content}
          components={mdxComponents}
          options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
        />
      </article>

      {post.faqs?.length ? (
        <section className="mt-12 pt-8 border-t border-[var(--border)]">
          <h2 className="u-display text-xl font-semibold text-[var(--text)]">
            {t.blog.faqTitle}
          </h2>
          <div className="mt-5 space-y-4">
            {post.faqs.map((f) => (
              <div key={f.question}>
                <h3 className="text-[15px] font-semibold text-[var(--text)]">{f.question}</h3>
                <p className="mt-1 text-[14px] leading-relaxed text-[var(--text-muted)]">
                  {f.answer}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {related.length > 0 && (
        <section className="mt-12 pt-8 border-t border-[var(--border)]">
          <div className="u-eyebrow">{t.blog.related}</div>
          <div className="mt-4 grid sm:grid-cols-2 gap-3">
            {related.map((r) => (
              <Link
                key={r.slug}
                href={`/${lang}/blog/${r.slug}`}
                className="lab-panel group rounded-lg p-4 hover:border-[var(--border-strong)] transition-colors"
              >
                <div className="u-mono text-[10px] uppercase tracking-[0.14em] text-[var(--data)]">
                  {r.category}
                </div>
                <div className="mt-1.5 text-[14px] font-semibold text-[var(--text)] group-hover:text-[var(--signal)] transition-colors inline-flex items-center gap-1">
                  {r.title}
                  <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
