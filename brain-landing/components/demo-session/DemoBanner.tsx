'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { demoCopy, demoSignInHref, formatDemoLeft, readDemoEnd } from './demo-copy'

/**
 * While a demo session is on, a bar on every page: the data is made up,
 * nothing can be changed, the time left, and «Leave the demo». It reads the
 * readable `demo_session` cookie (the demo's end), so it needs no request.
 * Same copy and behaviour as the family's `<DemoBanner>` (@inite/auth/demo-ui).
 */
export function DemoBanner({ lang }: { lang: string }) {
  const c = demoCopy(lang)
  // The cookie is read on the client only: the server snapshot is empty, so
  // the server render and the first client render agree (no banner), and
  // the banner appears once hydrated.
  const cookie = useSyncExternalStore(
    subscribeNever,
    () => document.cookie,
    () => '',
  )
  const end = readDemoEnd(cookie)
  const [now, setNow] = useState(() => Date.now())
  const hasEnd = end !== null

  useEffect(() => {
    if (!hasEnd) return
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [hasEnd])

  if (!end) return null
  const ended = end.getTime() <= now
  return (
    <div
      role="status"
      data-inite-demo-banner=""
      className="sticky top-0 z-[60] flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-2 text-sm bg-[var(--text)] text-[var(--bg)]"
    >
      {ended ? (
        <>
          <span>{c.ended}</span>
          <a href={demoSignInHref(lang)} className="font-semibold underline" rel="nofollow">
            {c.again}
          </a>
        </>
      ) : (
        <>
          <span>
            {c.banner} {c.note} {c.left.replace('{time}', formatDemoLeft(end.getTime() - now, lang))}
          </span>
          <form method="post" action="/api/auth/logout" className="inline">
            <button type="submit" className="font-semibold underline">
              {c.exit}
            </button>
          </form>
        </>
      )}
    </div>
  )
}

/** The cookie has no change event; a demo starts and ends with a navigation. */
function subscribeNever(): () => void {
  return () => {}
}
