'use client'

import { useParams } from 'next/navigation'
import { DemoWorkspace } from '../../../../components/demo-session/DemoWorkspace'
import { normalizeLang } from '../../../../lib/i18n'

/** /[lang]/app/demo — Ana's workspace at Atlântica Group (demo), for a demo session. */
export default function DemoPage() {
  const params = useParams<{ lang: string }>()
  return <DemoWorkspace lang={normalizeLang(params?.lang)} />
}
