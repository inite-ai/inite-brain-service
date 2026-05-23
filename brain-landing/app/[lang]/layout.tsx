import { notFound } from 'next/navigation'
import { LANGS, type Lang } from '../../lib/i18n'

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
  return <>{children}</>
}
