import fs from 'node:fs'
import path from 'node:path'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { MDXRemote } from 'next-mdx-remote/rsc'
import remarkGfm from 'remark-gfm'
import { mdxComponents } from '../../../mdx-components'
import { DEFAULT_LANG, LANGS, normalizeLang, type Lang } from '../../../lib/i18n'
import { SITE_URL } from '../../../lib/seo'

export const dynamicParams = false

interface Props {
  params: Promise<{ lang: string }>
}

/**
 * The privacy policy for the hosted service, at `content/legal/<lang>/privacy.mdx`.
 * English is canonical and binding; a missing translation falls back to it.
 */
function policy(lang: Lang): string | null {
  for (const l of [lang, DEFAULT_LANG]) {
    const file = path.join(process.cwd(), 'content', 'legal', l, 'privacy.mdx')
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  }
  return null
}

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const lang = normalizeLang((await params).lang)
  const title = lang === 'ru' ? 'Политика конфиденциальности · INITE Brain' : 'Privacy Policy · INITE Brain'
  const url = `${SITE_URL}/${lang}/privacy`
  return {
    title,
    description:
      lang === 'ru'
        ? 'Какие данные хранит INITE Brain, кому их передаёт и как их удалить.'
        : 'What INITE Brain stores, who it shares it with, and how to delete it.',
    alternates: {
      canonical: url,
      languages: Object.fromEntries(LANGS.map((l) => [l, `${SITE_URL}/${l}/privacy`])),
    },
  }
}

export default async function PrivacyPage({ params }: Props) {
  const lang = normalizeLang((await params).lang)
  const source = policy(lang)
  if (!source) notFound()
  return (
    <article className="docs-content">
      <MDXRemote
        source={source}
        components={mdxComponents}
        options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
      />
    </article>
  )
}
