import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// Boundary mocks MUST be registered before importing '@/store' or the hook.
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
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))
mock.module('@/api/macros', () => ({
  resolveMacrosBatch: async ({ templates }: { templates: Record<string, string> }) => ({ resolved: templates }),
}))
mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: async () => ({}),
    reportPerformance: async () => ({}),
    get: async () => ({}),
    update: async () => ({}),
  },
}))

const storeState: Record<string, unknown> = {}
const useStoreShim = Object.assign(
  (selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
  {
    getState: () => storeState,
    setState: (partial: Record<string, unknown>) => {
      Object.assign(storeState, partial)
    },
    subscribe: () => () => {},
  },
)
mock.module('@/store', () => ({ useStore: useStoreShim }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })

const originalWindow = globalThis.window
const originalDocument = globalThis.document

type HookModule = typeof import('./useDisplayRegex')

let useDisplayRegex: HookModule['useDisplayRegex']
let resetDisplayRegexCachesForTests: HookModule['resetDisplayRegexCachesForTests']
let resetDisplayCoalesceForTests: HookModule['resetDisplayCoalesceForTests']
let setDisplayCoalesceDepsForTests: HookModule['setDisplayCoalesceDepsForTests']

interface ManualTimer { fn: () => void; ms: number; cancelled: boolean }

function makeCoalesceClock() {
  const timers: ManualTimer[] = []
  let now = 1_000_000
  setDisplayCoalesceDepsForTests({
    now: () => now,
    scheduleTimer: (fn, ms) => {
      const timer: ManualTimer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  return {
    advance(ms: number) {
      const target = now + ms
      for (const t of [...timers]) {
        if (!t.cancelled && now + t.ms <= target) {
          t.cancelled = true
          t.fn()
        }
      }
      now = target
    },
  }
}

// Controllable fake worker: jobs are posted and answered manually.
class FakeWorker {
  static latest: FakeWorker | null = null
  sent: Array<{ jobId: number; body: string }> = []
  private handler: ((message: unknown) => void) | null = null

  constructor() {
    FakeWorker.latest = this
  }

  postMessage(message: { jobId: number; body: string }): void {
    this.sent.push(message)
  }

  terminate(): void {}
  setMessageHandler(handler: (message: unknown) => void): void { this.handler = handler }
  setErrorHandler(_handler: (error: Error) => void): void {}

  respond(jobId: number, result: string): void {
    this.handler?.({ type: 'result', jobId, op: 'apply', result, elapsedMs: 3 })
  }
}

beforeAll(async () => {
  const domWindow = dom.window as unknown as Window & typeof globalThis
  Object.assign(globalThis, { window: domWindow, document: domWindow.document })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  const workerClient = await import('@/lib/regex/worker-client')
  workerClient.setRegexWorkerDepsForTests({
    now: () => Date.now(),
    spawnWorker: () => new FakeWorker() as never,
    scheduleTimer: (fn, _ms) => () => {},
    isSupported: () => true,
  })

  const m = await import('./useDisplayRegex')
  useDisplayRegex = m.useDisplayRegex
  resetDisplayRegexCachesForTests = m.resetDisplayRegexCachesForTests
  resetDisplayCoalesceForTests = m.resetDisplayCoalesceForTests
  setDisplayCoalesceDepsForTests = m.setDisplayCoalesceDepsForTests
})

afterAll(() => {
  Object.assign(globalThis, { window: originalWindow, document: originalDocument })
})

function workerTierScript() {
  return {
    id: 'hook-tier-script',
    user_id: 'user',
    name: 'Hook tier script',
    script_id: 'hook_tier_script',
    // Oversized body (>8KB) pins the script to the worker tier even after a
    // recorded success, so later streaming chunks stay on the async pipeline.
    find_regex: `NEVER_MATCH${'a'.repeat(9 * 1024)}`,
    replace_string: 'x',
    actions: [],
    flags: 'g',
    placement: ['ai_output'],
    scope: 'global',
    scope_id: null,
    target: ['display'],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: 'none',
    disabled: false,
    sort_order: 0,
    description: '',
    folder: '',
    // analyzer risk low but NO ok-evidence -> worker tier -> async pipeline.
    metadata: { analyzer_risk: { risk: 'low', reasons: [], analyzed_at: 1 } },
    created_at: 0,
    updated_at: 0,
  }
}

function Harness(props: { content: string }): ReturnType<typeof createElement> {
  const out = useDisplayRegex(props.content, false, 0, undefined, undefined)
  return createElement('div', { 'data-testid': 'out' }, out)
}

describe('useDisplayRegex tiered pipeline pending-render contract', () => {
  beforeEach(() => {
    resetDisplayRegexCachesForTests()
    resetDisplayCoalesceForTests()
    storeState.regexScripts = [workerTierScript()]
    storeState.activeCharacterId = null
    storeState.activeGroupCharacterId = null
    storeState.activeChatId = 'chat-1'
    storeState.activePersonaId = null
    storeState.messages = []
  })

  test('no blank flash mid-stream: raw only before first resolve, carry-forward afterwards', async () => {
    const clock = makeCoalesceClock()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    const readOutput = (): string => container.querySelector('[data-testid="out"]')?.textContent ?? ''

    try {
      // First render: macro-bearing raw content with no cache -> raw text shown.
      await act(async () => {
        root.render(createElement(Harness, { content: '{{pendingA}}' }))
      })
      expect(readOutput()).toBe('{{pendingA}}')

      // The leading coalesce run posted one worker job; settle it.
      await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve()
      })
      const fake = FakeWorker.latest
      expect(fake).not.toBeNull()
      expect(fake!.sent.length).toBeGreaterThanOrEqual(1)
      await act(async () => {
        fake!.respond(fake!.sent[fake!.sent.length - 1].jobId, 'RESOLVED-A')
        for (let i = 0; i < 10; i++) await Promise.resolve()
      })
      expect(readOutput()).toBe('RESOLVED-A')

      // Mid-stream second chunk lands inside the coalesce refractory window.
      await act(async () => {
        root.render(createElement(Harness, { content: '{{pendingB}}' }))
      })
      // Before the trailing timer fires nothing new was submitted...
      expect(readOutput()).toBe('RESOLVED-A')
      clock.advance(180)

      // ...and while the new job is in flight the PREVIOUS resolved value is
      // carried forward — never blank, never raw macro text.
      expect(readOutput()).toBe('RESOLVED-A')

      // Settle the trailing job; final settled content resolves.
      await act(async () => {
        fake!.respond(fake!.sent[fake!.sent.length - 1].jobId, 'RESOLVED-B')
        for (let i = 0; i < 10; i++) await Promise.resolve()
      })
      expect(readOutput()).toBe('RESOLVED-B')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
