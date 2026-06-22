/* eslint-disable @next/next/no-img-element */
import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'

/**
 * Dynamic Open Graph images in the "lab / blueprint" brand: near-black
 * canvas, a faint grid, a mono INITE//BRAIN wordmark with a live signal
 * dot, a category kicker, the title in a bold face (Inter carries Cyrillic
 * so RU titles render), and a small knowledge-graph motif in the corner.
 *
 * ?title= &kicker= (or &category=) &kind=brand|blog|docs
 *
 * Fonts are fetched from gstatic at request time and edge-cached.
 */

export const runtime = 'edge'

const BG = '#070809'
const TEXT = '#e8eaed'
const MUTED = 'rgba(154,160,168,0.9)'
const FAINT = 'rgba(100,106,115,0.9)'
const BORDER = 'rgba(42,46,53,0.9)'
const SIGNAL = '#ffb938'
const DATA = '#5ce1e6'

function clip(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

async function loadFont(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { cache: 'force-cache' })
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

async function loadFonts() {
  const [interReg, interBold, interCyr, mono] = await Promise.all([
    loadFont('https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuLyfMZg.ttf'),
    loadFont('https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuI6fMZg.ttf'),
    loadFont('https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuLCfMZg.ttf'),
    loadFont('https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4xD-IQ-PuZJJXxfpAO-Lf1OQk6OThxPA.ttf'),
  ])
  const fonts: Array<{ name: string; data: ArrayBuffer; weight: 400 | 500 | 700 }> = []
  if (interReg) fonts.push({ name: 'Inter', data: interReg, weight: 400 })
  if (interBold) fonts.push({ name: 'Inter', data: interBold, weight: 700 })
  if (interCyr) fonts.push({ name: 'Inter', data: interCyr, weight: 500 })
  if (mono) fonts.push({ name: 'JetBrainsMono', data: mono, weight: 500 })
  return fonts
}

function GraphMotif() {
  const node = (x: number, y: number, c: string, r = 7) => (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: r,
        height: r,
        borderRadius: r,
        background: c,
      }}
    />
  )
  const edge = (x: number, y: number, w: number, rot: number) => (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: 1,
        background: 'rgba(92,225,230,0.4)',
        transform: `rotate(${rot}deg)`,
        transformOrigin: 'left center',
      }}
    />
  )
  return (
    <div style={{ position: 'absolute', right: 56, top: 150, width: 220, height: 200, display: 'flex' }}>
      {edge(20, 30, 90, 35)}
      {edge(20, 30, 70, -20)}
      {edge(95, 85, 80, 50)}
      {edge(80, 12, 70, 60)}
      {node(14, 24, SIGNAL, 9)}
      {node(90, 80, DATA)}
      {node(78, 6, DATA)}
      {node(150, 145, SIGNAL, 8)}
      {node(12, 92, DATA)}
    </div>
  )
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const kind = (searchParams.get('kind') || 'brand').toLowerCase()
    const title = clip(searchParams.get('title') || 'Memory that keeps time', 96)
    const defaultKicker =
      kind === 'blog' ? 'BLOG' : kind === 'docs' ? 'DOCS' : 'OPEN SOURCE · AGPL-3.0'
    const kicker = (searchParams.get('kicker') || searchParams.get('category') || defaultKicker).toUpperCase()
    const fonts = await loadFonts()
    const titleSize = title.length > 64 ? 56 : title.length > 40 ? 66 : 78

    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            background: BG,
            padding: 64,
            position: 'relative',
            fontFamily: 'Inter',
          }}
        >
          {/* grid */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage:
                'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            }}
          />
          {/* glows */}
          <div style={{ position: 'absolute', top: -120, left: -80, width: 560, height: 420, background: 'radial-gradient(closest-side, rgba(255,185,56,0.13), transparent)' }} />
          <div style={{ position: 'absolute', top: -60, right: -60, width: 520, height: 420, background: 'radial-gradient(closest-side, rgba(92,225,230,0.12), transparent)' }} />

          <GraphMotif />

          {/* top: wordmark + kicker */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 26, height: 26, borderRadius: 7, border: `1px solid ${SIGNAL}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 8, height: 8, borderRadius: 8, background: SIGNAL }} />
              </div>
              <div style={{ display: 'flex', fontFamily: 'JetBrainsMono', fontSize: 22, color: TEXT, letterSpacing: 1 }}>
                <span>INITE</span>
                <span style={{ color: FAINT }}>//</span>
                <span>BRAIN</span>
              </div>
            </div>
            <div style={{ fontFamily: 'JetBrainsMono', fontSize: 16, color: DATA, letterSpacing: 3, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 12px' }}>
              {kicker}
            </div>
          </div>

          {/* title */}
          <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', maxWidth: 920 }}>
            <div style={{ fontSize: titleSize, fontWeight: 700, color: TEXT, lineHeight: 1.05, letterSpacing: -1 }}>
              {title}
            </div>
          </div>

          {/* bottom */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
            <div style={{ fontFamily: 'JetBrainsMono', fontSize: 18, color: MUTED }}>brain.inite.ai</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ width: 80, height: 3, background: `linear-gradient(90deg, ${DATA}, ${SIGNAL})`, borderRadius: 3 }} />
              <div style={{ fontFamily: 'JetBrainsMono', fontSize: 15, color: FAINT }}>bitemporal knowledge graph</div>
            </div>
          </div>
        </div>
      ),
      { width: 1200, height: 630, fonts: fonts.length ? fonts : undefined },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return new Response(`OG error: ${msg}`, { status: 500 })
  }
}
