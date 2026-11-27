'use client'

import { useAuth } from '../../hooks/useAuth'
import { demoCopy, demoSignInHref } from './demo-copy'

/**
 * «Войти в демо» / «Try the demo»: opens Ana's workspace at Atlântica Group
 * (demo) through `/api/auth/demo`. Shown only when the deployment offers the
 * demo (DEMO_ENABLED=1, read from /api/auth/me) and the visitor is not
 * already in it.
 */
export function DemoSignInButton({ lang, className }: { lang: string; className?: string }) {
  const auth = useAuth()
  if (auth.loading || !auth.demoEnabled || auth.demo) return null
  return (
    <a href={demoSignInHref(lang)} className={className} rel="nofollow" data-inite-demo-button="">
      {demoCopy(lang).button}
    </a>
  )
}
