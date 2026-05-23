import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin', 'cyrillic'] })

export const metadata: Metadata = {
  title: 'INITE Brain Service — bitemporal knowledge graph for AI agents',
  description:
    'Per-tenant semantic memory with hybrid search, conflict-aware ingest, retract/forget that actually works. REST + MCP surfaces, eval-gated.',
  icons: { icon: '/favicon.ico' },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>{children}</body>
    </html>
  )
}
