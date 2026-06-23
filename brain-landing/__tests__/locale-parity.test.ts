/**
 * Locale parity — EN is the source of the Messages type and RU is cast to it
 * (`ru as Messages`), so a key present in EN but missing in RU renders
 * `undefined` on /ru with no compile error. This test enforces at runtime
 * what the cast suppresses: identical key shapes, and equal-length arrays for
 * the lists components map over.
 */
import { describe, it, expect } from 'vitest'
import en from '@/locales/en/common.json'
import ru from '@/locales/ru/common.json'

type Json = unknown

function keyPaths(obj: Json, prefix = ''): string[] {
  if (Array.isArray(obj)) {
    return obj.flatMap((v, i) => keyPaths(v, `${prefix}[${i}]`))
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj as Record<string, Json>).flatMap(([k, v]) =>
      keyPaths(v, prefix ? `${prefix}.${k}` : k),
    )
  }
  return [prefix]
}

describe('locale parity (en ↔ ru)', () => {
  it('every EN key path exists in RU', () => {
    const enKeys = new Set(keyPaths(en))
    const ruKeys = new Set(keyPaths(ru))
    const missing = [...enKeys].filter((k) => !ruKeys.has(k))
    expect(missing, `RU is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('RU has no keys absent from EN', () => {
    const enKeys = new Set(keyPaths(en))
    const ruKeys = new Set(keyPaths(ru))
    const extra = [...ruKeys].filter((k) => !enKeys.has(k))
    expect(extra, `RU has stray keys: ${extra.join(', ')}`).toEqual([])
  })

  it('mapped arrays have equal length in both locales', () => {
    const pairs: Array<[string, unknown[], unknown[]]> = [
      ['features.items', en.features.items, ru.features.items],
      ['retrieval.stages', en.retrieval.stages, ru.retrieval.stages],
      ['beyondVector.rows', en.beyondVector.rows, ru.beyondVector.rows],
      ['dualPath.selfHost.bullets', en.dualPath.selfHost.bullets, ru.dualPath.selfHost.bullets],
      ['dualPath.managed.bullets', en.dualPath.managed.bullets, ru.dualPath.managed.bullets],
      ['stats.items', en.stats.items, ru.stats.items],
    ]
    for (const [name, a, b] of pairs) {
      expect(b.length, `${name} length mismatch`).toBe(a.length)
    }
  })
})
