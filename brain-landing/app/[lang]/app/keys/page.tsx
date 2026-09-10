'use client'

import { useParams } from 'next/navigation'
import { KeysManager } from '../../../../components/app/KeysManager'
import { QuickstartTabs } from '../../../../components/QuickstartTabs'
import { normalizeLang } from '../../../../lib/i18n'

/**
 * Keys & integrations — where a tenant gets a credential.
 *
 * This screen used to render placeholder snippets and tell the reader to
 * contact their workspace admin, because there was nothing behind it: no
 * issuing endpoint existed. There is one now (`/v1/keys`, reached through
 * the end-user BFF), so the screen issues, lists and revokes keys, and
 * hands back configuration with the real values already in it.
 */
export default function KeysPage() {
  const params = useParams<{ lang: string }>()
  const lang = normalizeLang(params?.lang)

  return (
    <div className="max-w-3xl space-y-10">
      <KeysManager lang={lang} />
      <QuickstartTabs lang={lang} />
    </div>
  )
}
