function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getAttributeValue(attributes: string, name: string): string | undefined {
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  )
  return match?.slice(1).find((value) => value !== undefined)
}

function healLegacyColor(color: string): string {
  const trimmed = color.trim()
  const hexMatch = trimmed.match(/^#?([0-9a-fA-F]+)$/)
  if (hexMatch) {
    const hex = hexMatch[1]
    // Valid standard CSS hex lengths: 3 (#RGB), 4 (#RGBA), 6 (#RRGGBB), 8 (#RRGGBBAA)
    if (hex.length === 3 || hex.length === 4 || hex.length === 6 || hex.length === 8) {
      return `#${hex}`
    }
    // 5-digit hex (frequent LLM truncation): pad with 0 to 6 digits (#RRGGB0)
    if (hex.length === 5) {
      return `#${hex}0`
    }
    // 1 or 2 digits: pad to 6 digits
    if (hex.length < 6) {
      return `#${hex.padEnd(6, '0')}`
    }
    // 7 digits: pad with 0 to 8 digits
    if (hex.length === 7) {
      return `#${hex}0`
    }
  }
  return trimmed
}

/**
 * Converts deprecated HTML font tags to spans before rich HTML sanitization.
 * DOMPurify then applies the usual policy to the resulting style attribute.
 */
export function normalizeLegacyFontTags(html: string): string {
  return html
    .replace(/<font\b([^>]*)>/gi, (_match, attributes: string) => {
      const color = getAttributeValue(attributes, 'color')
      const style = getAttributeValue(attributes, 'style')
      const healedColor = color ? healLegacyColor(color) : null
      const safeColor = healedColor && /^[#\w\s(),.%+-]+$/.test(healedColor) ? healedColor : null
      const declarations = [
        safeColor ? `color:${safeColor}` : null,
        style?.trim() || null,
      ].filter((declaration): declaration is string => Boolean(declaration))

      return declarations.length > 0
        ? `<span style="${escapeHtmlAttribute(declarations.join(';'))}">`
        : '<span>'
    })
    .replace(/<\/font\s*>/gi, '</span>')
}
