import { redirect } from 'next/navigation'
import { normalizeLang } from '../../../lib/i18n'

interface Props {
  params: Promise<{ lang: string }>
}

export default async function AdminIndex({ params }: Props) {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  redirect(`/${lang}/admin/graph`)
}
