import { SITE_URL, ORG } from '../../../../lib/seo'
import { getMessages, normalizeLang, LANGS } from '../../../../lib/i18n'
import { listBlogPosts } from '../../../../lib/blog'

export const dynamic = 'force-static'

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }))
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function rfc822(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString()
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ lang: string }> },
) {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  const t = getMessages(lang)
  const base = `${SITE_URL}/${lang}/blog`
  const posts = listBlogPosts(lang)

  const items = posts
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${base}/${p.slug}</link>
      <guid isPermaLink="true">${base}/${p.slug}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <category>${esc(p.category)}</category>
      <description>${esc(p.description)}</description>
    </item>`,
    )
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(ORG.name)} — ${esc(t.blog.title)}</title>
    <link>${base}</link>
    <description>${esc(t.blog.subtitle)}</description>
    <language>${lang}</language>
    <atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
