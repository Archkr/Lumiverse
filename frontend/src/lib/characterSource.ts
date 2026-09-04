type JsonRecord = Record<string, unknown>

const CHUB_HOSTS = new Set([
  'chub.ai',
  'www.chub.ai',
  'characterhub.org',
  'www.characterhub.org',
])

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim()
    return decoded || null
  } catch {
    return null
  }
}

function pathFromSegments(segments: string[]): string | null {
  let start = 0
  if (CHUB_HOSTS.has(segments[0]?.toLowerCase())) start += 1
  if (segments[start]?.toLowerCase() === 'characters') start += 1

  const creator = decodeSegment(segments[start] ?? '')
  const character = decodeSegment(segments[start + 1] ?? '')
  return creator && character ? `${creator}/${character}` : null
}

/** Read the portable Chub attribution path used by existing character cards. */
export function readChubFullPath(extensions: unknown): string | null {
  if (!isRecord(extensions)) return null

  const chub = isRecord(extensions.chub) ? extensions.chub : null
  const value =
    typeof chub?.full_path === 'string' ? chub.full_path
      : typeof chub?.fullPath === 'string' ? chub.fullPath
        : typeof extensions._lumiverse_chub_slug === 'string' ? extensions._lumiverse_chub_slug
          : ''

  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^https?:\/\//i.test(trimmed)) return parseChubSourceInput(trimmed)
  return trimmed.replace(/^\/+|\/+$/g, '') || null
}

/** Accept a Chub/CharacterHub URL or a portable creator/character path. */
export function parseChubSourceInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) return null
    try {
      const parsed = new URL(trimmed)
      if (!CHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null
      return pathFromSegments(parsed.pathname.split('/').filter(Boolean))
    } catch {
      return null
    }
  }

  const withoutQuery = trimmed.split(/[?#]/, 1)[0]
  return pathFromSegments(withoutQuery.split('/').filter(Boolean))
}

export function chubSourceUrl(fullPath: string | null): string | null {
  if (!fullPath) return null
  const encodedPath = fullPath.split('/').map(encodeURIComponent).join('/')
  return `https://chub.ai/characters/${encodedPath}`
}

/** Update only source attribution fields, preserving all unrelated metadata. */
export function setChubFullPath(
  extensions: Record<string, any>,
  fullPath: string | null,
): Record<string, any> {
  const normalized = fullPath?.trim().replace(/^\/+|\/+$/g, '') || null
  const next = { ...extensions }
  const existingChub = isRecord(next.chub) ? next.chub : null
  const chub = { ...(existingChub ?? {}) }

  delete chub.full_path
  delete chub.fullPath

  if (normalized) {
    chub.full_path = normalized
    next.chub = chub
    if (typeof next._lumiverse_chub_slug === 'string') {
      next._lumiverse_chub_slug = normalized
    }
  } else {
    if (Object.keys(chub).length > 0) next.chub = chub
    else delete next.chub
    delete next._lumiverse_chub_slug
  }

  return next
}
