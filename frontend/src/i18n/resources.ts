/**
 * Lazy-load locale JSON per language. Edit/add JSON under locales/<lng>/ — no codegen step.
 * Vite groups each language folder into one chunk (see vite.config manualChunks).
 */
import type { I18nNamespace } from './resources.types'

export { I18N_NAMESPACES, type I18nNamespace } from './resources.types'

type LocaleJsonLoader = () => Promise<{ default: Record<string, unknown> }>

const isViteRuntime = typeof import.meta.env.DEV === 'boolean'
const emptyGlob: Record<string, LocaleJsonLoader> = {}

const languageGlobs = {
  en: isViteRuntime ? import.meta.glob('./locales/en/*.json') as Record<string, LocaleJsonLoader> : emptyGlob,
  zh: isViteRuntime ? import.meta.glob('./locales/zh/*.json') as Record<string, LocaleJsonLoader> : emptyGlob,
  'zh-TW': isViteRuntime ? import.meta.glob('./locales/zh-TW/*.json') as Record<string, LocaleJsonLoader> : emptyGlob,
  ja: isViteRuntime ? import.meta.glob('./locales/ja/*.json') as Record<string, LocaleJsonLoader> : emptyGlob,
  fr: isViteRuntime ? import.meta.glob('./locales/fr/*.json') as Record<string, LocaleJsonLoader> : emptyGlob,
  it: isViteRuntime ? import.meta.glob('./locales/it/*.json') as Record<string, LocaleJsonLoader> : emptyGlob,
}

export type UiLanguage = keyof typeof languageGlobs

const nsFromPathRe = /\/([^/]+)\.json$/

const loadedLanguages = new Set<string>()

/** Fallback chain must be loaded before switching to `lng`. */
export function fallbackLanguagesFor(lng: string): string[] {
  const chain: string[] = [lng]
  if (lng === 'zh-TW') chain.push('zh')
  if (lng !== 'en') chain.push('en')
  return [...new Set(chain)]
}

export async function loadLanguageBundles(
  lng: string,
  addBundle: (lng: string, ns: I18nNamespace, data: Record<string, unknown>) => void,
): Promise<void> {
  if (loadedLanguages.has(lng)) return

  const glob = languageGlobs[lng as UiLanguage]
  if (!glob) {
    console.warn(`[i18n] unknown language: ${lng}`)
    return
  }

  await Promise.all(
    Object.entries(glob).map(async ([filePath, load]) => {
      const m = filePath.match(nsFromPathRe)
      if (!m) return
      const mod = await load()
      addBundle(lng, m[1] as I18nNamespace, mod.default)
    }),
  )

  loadedLanguages.add(lng)
}
