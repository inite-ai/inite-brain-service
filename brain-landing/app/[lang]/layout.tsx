import { notFound } from 'next/navigation'
import { LANGS, type Lang } from '../../lib/i18n'
import { DemoBanner } from '../../components/demo-session/DemoBanner'

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }))
}

interface Props {
  children: React.ReactNode
  params: Promise<{ lang: string }>
}

export default async function LangLayout({ children, params }: Props) {
  const { lang } = await params
  if (!LANGS.includes(lang as Lang)) notFound()
  // The demo banner shows on every page while a demo session is on (it
  // renders nothing otherwise).
  return (
    <>
      <DemoBanner lang={lang} />
      {children}
    </>
  )
}
