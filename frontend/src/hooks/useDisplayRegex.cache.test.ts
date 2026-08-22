import { describe, test, expect, beforeEach, mock } from 'bun:test'

// useDisplayRegex transitively imports '@/i18n' whose resources.ts uses Vite's
// import.meta.glob (unavailable under bun test). Mock the boundary like
// useMessageCard.edit-and-send.test.ts does. These MUST be registered before
// any static/dynamic import of '@/store' or './useDisplayRegex', so this file
// deliberately has no other top-level imports.
const i18nStub = {
  default: { t: (k: string) => k, language: 'en', on: () => {}, off: () => {} },
  i18n: { t: (k: string) => k, language: 'en', on: () => {}, off: () => {} },
  initI18n: async () => i18nStub.default,
  ensureLanguageLoaded: async () => {},
  changeUiLanguage: async () => {},
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
}
mock.module('@/i18n', () => i18nStub)
mock.module('@/lib/toast', () => ({
  toast: { warning: () => {}, success: () => {}, error: () => {}, info: () => {} },
}))
// Pulled in by the '@/store' graph; uses Vite-only import.meta.glob.
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))
// Minimal zustand-shaped store shim. Neighbor hook tests also register
// process-wide '@/store' mocks lacking setState/getState, which would poison
// this file under whole-directory runs; owning the boundary here keeps the
// ownership-gating tests deterministic regardless of file execution order.
const storeState: { activeChatId: string | null; activeChatDisplayOwner: string | null } = {
  activeChatId: null,
  activeChatDisplayOwner: null,
}
const storeListeners = new Set<() => void>()
const useStoreShim = Object.assign(
  (selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
  {
    getState: () => storeState,
    setState: (partial: Partial<typeof storeState>) => {
      Object.assign(storeState, partial)
      for (const l of storeListeners) l()
    },
    subscribe: (l: () => void) => {
      storeListeners.add(l)
      return () => { storeListeners.delete(l) }
    },
  },
)
mock.module('@/store', () => ({ useStore: useStoreShim }))

type DisplayRegexModule = typeof import('./useDisplayRegex')

let storePromise: Promise<typeof import('@/store')['useStore']> | null = null
function loadStore(): Promise<typeof import('@/store')['useStore']> {
  if (!storePromise) storePromise = import('@/store').then((m) => m.useStore)
  return storePromise
}

let modPromise: Promise<DisplayRegexModule> | null = null
function loadMod(): Promise<DisplayRegexModule> {
  if (!modPromise) modPromise = import('./useDisplayRegex')
  return modPromise
}

async function resetStore(): Promise<void> {
  const useStore = await loadStore()
  useStore.setState({ activeChatId: null, activeChatDisplayOwner: null })
}

describe('displayPreprocessCache invalidation semantics', () => {
  let invalidateDisplayRegexCacheForVars: DisplayRegexModule['invalidateDisplayRegexCacheForVars']
  let invalidateDisplayRegexCache: DisplayRegexModule['invalidateDisplayRegexCache']
  let seedDisplayPreprocessEntryForTests: DisplayRegexModule['seedDisplayPreprocessEntryForTests']
  let resetDisplayRegexCachesForTests: DisplayRegexModule['resetDisplayRegexCachesForTests']
  let getDisplayPreprocessCacheStatsForTests: DisplayRegexModule['getDisplayPreprocessCacheStatsForTests']

  beforeEach(async () => {
    const m = await loadMod()
    invalidateDisplayRegexCacheForVars = m.invalidateDisplayRegexCacheForVars
    invalidateDisplayRegexCache = m.invalidateDisplayRegexCache
    seedDisplayPreprocessEntryForTests = m.seedDisplayPreprocessEntryForTests
    resetDisplayRegexCachesForTests = m.resetDisplayRegexCachesForTests
    getDisplayPreprocessCacheStatsForTests = m.getDisplayPreprocessCacheStatsForTests
    resetDisplayRegexCachesForTests()
    resetStore()
  })

  test('dependency-free entry without touchedVars survives var invalidation', () => {
    seedDisplayPreprocessEntryForTests({ key: 'k1', value: 'a', messageId: 'm1' })
    invalidateDisplayRegexCacheForVars(new Set(['local:x']))
    expect(getDisplayPreprocessCacheStatsForTests().size).toBe(1)
  })

  test('full invalidation still wipes dependency-free entries', () => {
    seedDisplayPreprocessEntryForTests({ key: 'k4', value: 'd', messageId: 'm4' })
    invalidateDisplayRegexCache()
    expect(getDisplayPreprocessCacheStatsForTests().size).toBe(0)
  })

  test('content cache dependency-free entry survives var invalidation', async () => {
    const { seedDisplayContentEntryForTests, getDisplayContentCacheStatsForTests } = await loadMod()
    seedDisplayContentEntryForTests({ key: 'ck', value: 'v' })
    invalidateDisplayRegexCacheForVars(new Set(['local:x']))
    expect(getDisplayContentCacheStatsForTests().hasKey('ck')).toBe(true)
  })

  test('entry with non-matching touchedVars survives var invalidation', () => {
    seedDisplayPreprocessEntryForTests({ key: 'k2', value: 'b', messageId: 'm2', touchedVars: ['local:a'] })
    invalidateDisplayRegexCacheForVars(new Set(['local:x']))
    expect(getDisplayPreprocessCacheStatsForTests().size).toBe(1)
  })

  test('entry with matching touchedVars is wiped', () => {
    seedDisplayPreprocessEntryForTests({ key: 'k3', value: 'c', messageId: 'm3', touchedVars: ['__msg__'] })
    invalidateDisplayRegexCacheForVars(new Set(['__msg__']))
    expect(getDisplayPreprocessCacheStatsForTests().size).toBe(0)
  })

  test('fetchDisplayPreprocess passes resolver touchedVars/cacheable through', async () => {
    const { registerDisplayResolver, unregisterDisplayResolver } =
      await import('@/lib/spindle/display-resolver-registry')
    const { fetchDisplayPreprocess } = await loadMod()
    // Ownership gating requires activeChatId + activeChatDisplayOwner in the
    // store AND resolver.ready(chatId) — see display-resolver-registry.ts:11-27.
    const useStore = await loadStore()
    useStore.setState({ activeChatId: 'chat-test-owned', activeChatDisplayOwner: 'test-ext' })
    registerDisplayResolver('test-ext', {
      ready: async () => true,
      resolveBody: async () => ({ content: 'resolved', touchedVars: ['local:a'], cacheable: true }),
    } as never)
    try {
      const outcome = await fetchDisplayPreprocess('chat-test-owned', {
        messageId: 'm9', role: 'ai', rawContent: 'raw',
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.touchedVars).toEqual(['local:a'])
      expect(outcome.cacheable).toBe(true)
    } finally {
      unregisterDisplayResolver('test-ext')
      resetStore()
    }
  })

  test('fetchDisplayPreprocess reports volatile results as cacheable:false', async () => {
    const { registerDisplayResolver, unregisterDisplayResolver } =
      await import('@/lib/spindle/display-resolver-registry')
    const { fetchDisplayPreprocess } = await loadMod()
    const useStore = await loadStore()
    useStore.setState({ activeChatId: 'chat-test-owned', activeChatDisplayOwner: 'test-ext' })
    registerDisplayResolver('test-ext', {
      ready: async () => true,
      resolveBody: async () => ({ content: 'resolved', touchedVars: [], cacheable: false }),
    } as never)
    try {
      const outcome = await fetchDisplayPreprocess('chat-test-owned', {
        messageId: 'm10', role: 'ai', rawContent: 'raw',
      })
      expect(outcome.cacheable).toBe(false)
    } finally {
      unregisterDisplayResolver('test-ext')
      resetStore()
    }
  })
})

describe('displayRegexContentCache cap', () => {
  beforeEach(async () => {
    const m = await loadMod()
    m.resetDisplayRegexCachesForTests()
  })

  test('content cache never exceeds the cap', async () => {
    const { seedDisplayContentEntryForTests, getDisplayContentCacheStatsForTests } = await loadMod()
    for (let i = 0; i < 350; i++) {
      seedDisplayContentEntryForTests({ key: `ck${i}`, value: `v${i}`, messageId: `m${i}` })
    }
    expect(getDisplayContentCacheStatsForTests().size).toBeLessThanOrEqual(300)
    // Oldest entries evicted, newest retained
    expect(getDisplayContentCacheStatsForTests().hasKey('ck0')).toBe(false)
    expect(getDisplayContentCacheStatsForTests().hasKey('ck349')).toBe(true)
  })
})
