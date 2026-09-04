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
  if (!hexMatch) {
    return trimmed === '#' ? '' : trimmed
  }

  const hex = hexMatch[1]
  const len = hex.length

  // Valid standard CSS hex: 3 (#RGB), 4 (#RGBA), 6 (#RRGGBB), 8 (#RRGGBBAA)
  if (len === 3 || len === 4 || len === 6 || len === 8) {
    return `#${hex}`
  }
  // 1, 2, or 5 digits (LLM truncation & WHATWG legacy zero-padding): pad to 6 digits (#RRGGBB)
  if (len < 6) {
    return `#${hex.padEnd(6, '0')}`
  }
  // 7 or >8 digits: truncate to standard 6-digit #RRGGBB (avoids accidental CSS alpha transparency)
  return `#${hex.slice(0, 6)}`
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
