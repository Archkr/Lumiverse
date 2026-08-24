import { describe, expect, test } from 'bun:test'
import { hasEnabledFrontendExtension } from './frontend-extension-availability'

describe('frontend extension availability', () => {
  test('requires an installed, enabled frontend extension with the requested identifier', () => {
    const hasSuite = (extensions: Parameters<typeof hasEnabledFrontendExtension>[0]) => (
      hasEnabledFrontendExtension(extensions, 'lumiverse_suite')
    )

    expect(hasSuite(undefined)).toBe(false)
    expect(hasSuite([])).toBe(false)
    expect(hasSuite([{ identifier: 'another_extension', enabled: true, has_frontend: true }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: false, has_frontend: true }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: true, has_frontend: false }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: true, has_frontend: true }])).toBe(true)
  })
})
