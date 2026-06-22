import './globals.css'
import type { Metadata } from 'next'
import { Unbounded, Manrope, JetBrains_Mono } from 'next/font/google'

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
  title: 'INITE Brain — bitemporal knowledge graph for AI agents',
  description:
    'Open-source (AGPL-3.0) per-tenant memory layer for AI agents. Bitemporal facts, hybrid retrieval, conflict-aware ingest, GDPR forget that actually works. Self-host with Docker or use the managed endpoint. REST + native MCP, eval-gated in CI.',
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
    title: 'INITE Brain — memory that keeps time',
    description:
      'Open-source bitemporal knowledge graph for AI agents. Hybrid retrieval, conflict-aware ingest, GDPR forget. Self-host or managed. REST + native MCP.',
    url: 'https://brain.inite.ai',
    siteName: 'INITE Brain',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'INITE Brain — memory that keeps time',
    description:
      'Open-source bitemporal knowledge graph for AI agents. Self-host or managed. REST + native MCP, eval-gated.',
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
