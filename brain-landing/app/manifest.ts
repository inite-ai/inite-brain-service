import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'INITE Brain — bitemporal knowledge graph for AI agents',
    short_name: 'INITE Brain',
    description:
      'Open-source per-tenant memory layer for AI agents. Bitemporal facts, hybrid retrieval, GDPR forget. REST + native MCP.',
    start_url: '/',
    display: 'standalone',
    background_color: '#070809',
    theme_color: '#070809',
    icons: [{ src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' }],
  }
}
