import { redirect } from 'next/navigation'

/** /[lang]/app → Search & Ask is the product home. */
export default async function AppHome({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const { lang } = await params
  redirect(`/${lang}/app/search`)
}
