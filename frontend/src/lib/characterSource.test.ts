import { describe, expect, test } from 'bun:test'
import {
  chubSourceUrl,
  parseChubSourceInput,
  readChubFullPath,
  setChubFullPath,
} from './characterSource'

describe('character source attribution', () => {
  test('reads current, legacy, and Lumiverse fallback paths', () => {
    expect(readChubFullPath({ chub: { full_path: '/creator/card/' } })).toBe('creator/card')
    expect(readChubFullPath({ chub: { fullPath: 'legacy/card' } })).toBe('legacy/card')
    expect(readChubFullPath({ _lumiverse_chub_slug: 'fallback/card' })).toBe('fallback/card')
    expect(readChubFullPath({ chub: { full_path: 'https://chub.ai/characters/url/card' } })).toBe('url/card')
  })

  test('accepts supported source URLs and portable paths', () => {
    expect(parseChubSourceInput('https://chub.ai/characters/Creator/Card?view=full')).toBe('Creator/Card')
    expect(parseChubSourceInput('https://characterhub.org/characters/Creator/Card/')).toBe('Creator/Card')
    expect(parseChubSourceInput('chub.ai/characters/Creator/Card')).toBe('Creator/Card')
    expect(parseChubSourceInput('characters/Creator/Card')).toBe('Creator/Card')
    expect(parseChubSourceInput('Creator/Card')).toBe('Creator/Card')
    expect(chubSourceUrl('Creator/Card')).toBe('https://chub.ai/characters/Creator/Card')
  })

  test('rejects unsupported or incomplete sources', () => {
    expect(parseChubSourceInput('https://example.com/characters/Creator/Card')).toBeNull()
    expect(parseChubSourceInput('ftp://chub.ai/characters/Creator/Card')).toBeNull()
    expect(parseChubSourceInput('https://chub.ai/characters/Creator')).toBeNull()
    expect(parseChubSourceInput('not-a-source')).toBeNull()
  })

  test('updates source fields without discarding extension metadata', () => {
    const next = setChubFullPath({
      unrelated: { keep: true },
      _lumiverse_chub_slug: 'old/card',
      chub: { fullPath: 'old/card', description: 'keep' },
    }, 'new/card')

    expect(next).toEqual({
      unrelated: { keep: true },
      _lumiverse_chub_slug: 'new/card',
      chub: { full_path: 'new/card', description: 'keep' },
    })
  })

  test('clears source fields without discarding other Chub metadata', () => {
    const next = setChubFullPath({
      unrelated: true,
      _lumiverse_chub_slug: 'old/card',
      chub: { full_path: 'old/card', description: 'keep' },
    }, null)

    expect(next).toEqual({
      unrelated: true,
      chub: { description: 'keep' },
    })
  })
})
