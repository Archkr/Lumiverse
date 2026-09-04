/// <reference types="bun-types" />

import { expect, test } from 'bun:test'
import { normalizeLegacyFontTags } from './legacyFontTags'

test('preserves inline styles when converting legacy font tags', () => {
  expect(
    normalizeLegacyFontTags('<font color="#E8534A" style="font-weight:bold">Alert</font>'),
  ).toBe('<span style="color:#E8534A;font-weight:bold">Alert</span>')
})

test('keeps a font style when no color attribute is present', () => {
  expect(normalizeLegacyFontTags('<font style="font-style:italic">Note</font>'))
    .toBe('<span style="font-style:italic">Note</span>')
})

test('heals 5-digit hex colors into valid 6-digit CSS hex colors', () => {
  expect(normalizeLegacyFontTags('<font color="#7FA83">"Bored."</font>'))
    .toBe('<span style="color:#7FA830">"Bored."</span>')
  expect(normalizeLegacyFontTags('<font color="7FA83">"Bored."</font>'))
    .toBe('<span style="color:#7FA830">"Bored."</span>')
  expect(normalizeLegacyFontTags('<font color="#7FA86">Text</font>'))
    .toBe('<span style="color:#7FA860">Text</span>')
})

