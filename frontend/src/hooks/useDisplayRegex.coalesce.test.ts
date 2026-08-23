import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { DisplayCoalesceDeps } from './useDisplayRegex'

// useDisplayRegex transitively imports '@/i18n' whose resources.ts uses Vite's
// import.meta.glob (unavailable under bun test). Mock the boundaries exactly
// like useDisplayRegex.cache.test.ts — these MUST be registered before any
// import of '@/store' or './useDisplayRegex', so this file deliberately has no
// other top-level imports.
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

type DisplayRegexModule = typeof import('./useDisplayRegex')

let modPromise: Promise<DisplayRegexModule> | null = null
function loadMod(): Promise<DisplayRegexModule> {
  if (!modPromise) modPromise = import('./useDisplayRegex')
  return modPromise
}

// Manual clock + timer queue: deterministic stand-in for fake timers.
function makeFakeDeps(): DisplayCoalesceDeps & {
  advance(ms: number): void
  pendingTimerCount(): number
} {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    scheduleTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return () => {
        timers.delete(id)
      }
    },
    advance(ms) {
      const target = now + ms
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) {
        if (!timers.has(id)) continue
        timers.delete(id)
        now = Math.max(now, t.at)
        t.fn()
      }
      now = target
    },
    pendingTimerCount: () => timers.size,
  }
}

type CoalesceModule = {
  scheduleCoalescedDisplayResolve: DisplayRegexModule['scheduleCoalescedDisplayResolve']
  setDisplayCoalesceDepsForTests: DisplayRegexModule['setDisplayCoalesceDepsForTests']
  resetDisplayCoalesceForTests: DisplayRegexModule['resetDisplayCoalesceForTests']
}

describe('scheduleCoalescedDisplayResolve', () => {
  let deps: ReturnType<typeof makeFakeDeps>
  let scheduleCoalescedDisplayResolve: CoalesceModule['scheduleCoalescedDisplayResolve']
  let setDisplayCoalesceDepsForTests: CoalesceModule['setDisplayCoalesceDepsForTests']
  let resetDisplayCoalesceForTests: CoalesceModule['resetDisplayCoalesceForTests']

  beforeEach(async () => {
    const m = await loadMod()
    ;({ scheduleCoalescedDisplayResolve, setDisplayCoalesceDepsForTests, resetDisplayCoalesceForTests } = m)
    resetDisplayCoalesceForTests()
    deps = makeFakeDeps()
    setDisplayCoalesceDepsForTests(deps)
  })

  test('(a) burst of N calls collapses to exactly 1 leading + 1 trailing exec', () => {
    let execs = 0
    for (let i = 0; i < 8; i++) {
      scheduleCoalescedDisplayResolve('chat|m1|pre', () => {
        execs++
      })
    }
    // Leading call runs immediately; the other 7 are coalesced away.
    expect(execs).toBe(1)
    expect(deps.pendingTimerCount()).toBe(1)
    deps.advance(180)
    expect(execs).toBe(2)
    expect(deps.pendingTimerCount()).toBe(0)
  })

  test('(b) trailing exec receives the LAST closure', () => {
    const ran: number[] = []
    for (let i = 1; i <= 5; i++) {
      scheduleCoalescedDisplayResolve('chat|m1|apply', () => {
        ran.push(i)
      })
    }
    expect(ran).toEqual([1])
    deps.advance(180)
    expect(ran).toEqual([1, 5])
  })

  test('(c) cleanup drops the pending closure, rerun re-arms and flushes', () => {
    const ran: string[] = []
    // Leading run for closure A.
    const cancelA = scheduleCoalescedDisplayResolve('chat|m1|pre', () => {
      ran.push('A')
    })
    expect(ran).toEqual(['A'])
    // Mid-burst call B becomes pending...
    const cancelB = scheduleCoalescedDisplayResolve('chat|m1|pre', () => {
      ran.push('B')
    })
    expect(deps.pendingTimerCount()).toBe(1)
    // ...then the effect re-runs: B's cleanup drops it as pending...
    cancelB()
    cancelA()
    // ...and the fresh effect schedules C, which must be the one that fires.
    scheduleCoalescedDisplayResolve('chat|m1|pre', () => {
      ran.push('C')
    })
    expect(ran).toEqual(['A'])
    deps.advance(180)
    expect(ran).toEqual(['A', 'C'])
  })

  test('null key bypasses coalescing entirely', () => {
    let execs = 0
    for (let i = 0; i < 3; i++) {
      scheduleCoalescedDisplayResolve(null, () => {
        execs++
      })
    }
    expect(execs).toBe(3)
    expect(deps.pendingTimerCount()).toBe(0)
  })

  test('leading edge only when idle: back-to-back bursts pace at the window', () => {
    let execs = 0
    scheduleCoalescedDisplayResolve('k', () => {
      execs++
    })
    expect(execs).toBe(1)
    deps.advance(100)
    // Still inside refractory window -> trailing scheduled, not leading.
    scheduleCoalescedDisplayResolve('k', () => {
      execs++
    })
    expect(execs).toBe(1)
    deps.advance(80)
    expect(execs).toBe(2)
    // Window has fully elapsed since lastRun -> immediate leading run again.
    deps.advance(180)
    scheduleCoalescedDisplayResolve('k', () => {
      execs++
    })
    expect(execs).toBe(3)
    expect(deps.pendingTimerCount()).toBe(0)
  })

  test('different keys coalesce independently', () => {
    const ran: string[] = []
    scheduleCoalescedDisplayResolve('k1', () => {
      ran.push('k1-lead')
    })
    scheduleCoalescedDisplayResolve('k2', () => {
      ran.push('k2-lead')
    })
    expect(ran).toEqual(['k1-lead', 'k2-lead'])
    scheduleCoalescedDisplayResolve('k1', () => {
      ran.push('k1-trail')
    })
    scheduleCoalescedDisplayResolve('k2', () => {
      ran.push('k2-trail')
    })
    expect(deps.pendingTimerCount()).toBe(2)
    deps.advance(180)
    expect(ran).toEqual(['k1-lead', 'k2-lead', 'k1-trail', 'k2-trail'])
  })
})
