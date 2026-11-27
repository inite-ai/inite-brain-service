import type { Metadata } from 'next'
import type { ReactNode } from 'react'

/** The demo workspace is never indexed (and is not in the sitemap). */
export const metadata: Metadata = {
  title: 'Demo workspace',
  robots: { index: false, follow: false },
}

export default function DemoLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
