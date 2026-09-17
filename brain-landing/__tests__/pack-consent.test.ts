/**
 * The install consent flow keys off the backend's 400 message naming the
 * flag it wants (mcp-consent.ts / modality-consent.ts /
 * sources-consent.ts all end with "repeat the install with <flag>: true").
 * The panel used to recognise only acceptMcpTools, so a pack declaring
 * modalities or sources could not be installed from the UI at all.
 */
import { describe, it, expect } from 'vitest'
import { consentFlagOf, PACK_CONSENT_FLAGS } from '@/lib/pack-consent'

describe('consentFlagOf', () => {
  it('recognises each gate by its own flag', () => {
    expect(
      consentFlagOf(
        'Pack "x" declares 2 MCP tool(s): … Review them and repeat the install with acceptMcpTools: true.',
      ),
    ).toBe('acceptMcpTools')
    expect(
      consentFlagOf(
        'Pack "x" declares modalities … Review the declaration and repeat the install with acceptModalities: true.',
      ),
    ).toBe('acceptModalities')
    expect(
      consentFlagOf(
        'Pack "file_memory" declares 4 source(s): … Review them and repeat the install with acceptSources: true.',
      ),
    ).toBe('acceptSources')
  })

  it('ignores errors that merely mention a flag without asking for it', () => {
    expect(consentFlagOf('acceptSources must be a boolean')).toBeNull()
    expect(consentFlagOf('pack "x" is not installed')).toBeNull()
    expect(consentFlagOf(undefined)).toBeNull()
    expect(consentFlagOf({ message: 'acceptSources: true' })).toBeNull()
  })

  it('lists the three gates in the order the backend runs them', () => {
    expect([...PACK_CONSENT_FLAGS]).toEqual([
      'acceptMcpTools',
      'acceptModalities',
      'acceptSources',
    ])
  })
})
