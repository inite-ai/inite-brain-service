import './globals.css'
import type { Metadata } from 'next'
import { Unbounded, Manrope, JetBrains_Mono } from 'next/font/google'
import { ogImage, ORG } from '../lib/seo'

// Lab / blueprint type system — a distinctive display face, a clean
// readable body, and a dominant mono that carries the "instrument
// readout" chrome. All three ship Cyrillic so the /ru surface matches.
const display = Unbounded({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-display',
  display: 'swap',
})
const body = Manrope({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-body',
  display: 'swap',
})
const mono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://brain.inite.ai'),
  title: 'INITE Brain — memory with context',
  description: ORG.description,
  keywords: [
    'knowledge graph',
    'bitemporal',
    'AI agents',
    'MCP',
    'semantic memory',
    'RAG',
    'open source',
    'SurrealDB',
    'self-hosted',
  ],
  icons: { icon: '/favicon.ico' },
  openGraph: {
    title: 'INITE Brain — memory with context',
    description: ORG.description,
    url: 'https://brain.inite.ai',
    siteName: 'INITE Brain',
    type: 'website',
    images: [{ url: ogImage({ title: 'Memory with context' }), width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'INITE Brain — memory with context',
    description: ORG.description,
    images: [ogImage({ title: 'Memory with context' })],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body>{children}</body>
    </html>
  )
}
