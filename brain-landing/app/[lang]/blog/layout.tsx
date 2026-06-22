import { Header } from '../../../components/Header'
import { getMessages, normalizeLang } from '../../../lib/i18n'

interface Props {
  children: React.ReactNode
  params: Promise<{ lang: string }>
}

export default async function BlogLayout({ children, params }: Props) {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  const t = getMessages(lang)
  return (
    <div className="lab-root min-h-screen">
      <Header lang={lang} context={t.nav.blog} />
      <main className="max-w-3xl mx-auto px-5 sm:px-6 py-10">{children}</main>
    </div>
  )
}
